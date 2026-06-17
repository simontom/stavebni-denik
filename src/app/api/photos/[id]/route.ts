import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { auth } from "@/server/auth";
import type { SessionUser } from "@/server/permissions";
import {
  getPhotoFileForUser,
  type PhotoVariant,
} from "@/server/services/photos";

/**
 * Auth-gated photo serving endpoint.
 *
 * `GET /api/photos/[id]` returns the resized 1920 px JPEG.
 * `GET /api/photos/[id]?variant=thumb` returns the 400 px thumbnail.
 *
 * Photos can only be served to users who can see the underlying project
 * (BOSS, or members for non-BOSS roles). Missing photos, photos in
 * deleted projects and unauthenticated calls all return 404 — we never
 * leak existence.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const session = await auth();
  const user = session?.user as SessionUser | undefined;
  if (!user) {
    return new Response("Not found", { status: 404 });
  }

  const { id } = await context.params;
  if (!id || id.length > 60) {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const variantParam = url.searchParams.get("variant");
  const variant: PhotoVariant = variantParam === "thumb" ? "thumb" : "main";

  const file = await getPhotoFileForUser({ photoId: id, variant, user });
  if (!file) {
    return new Response("Not found", { status: 404 });
  }

  // Stream the file directly (no buffering) so 1920 px JPEGs don't
  // sit in RSS until the response ends.
  const webStream = Readable.toWeb(
    createReadStream(file.absolutePath),
  ) as NodeReadableStream<Uint8Array>;

  return new Response(webStream as unknown as ReadableStream<Uint8Array>, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(file.bytes),
      // Photos are immutable per id+variant (we never re-encode in place).
      // 1 day in private cache is plenty without complicating cache busting.
      "Cache-Control": "private, max-age=86400, immutable",
      // Encourage the browser to display rather than download.
      "Content-Disposition": "inline",
    },
  });
}
