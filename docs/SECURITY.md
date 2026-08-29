# Security Architecture

## Image Upload Pipeline

The daily report photo upload pipeline (`/api/photos/upload`) handles untrusted binary data from users. It is designed as a strict "one-way airlock" to prevent common image-based vulnerabilities.

### Threat Model & Mitigations

#### 1. Polyglot Images (e.g., Image + ZIP/JS/PHP)
A polyglot file has a valid image header but contains a malicious payload (like a PHP script) appended to the end.
*   **Mitigation**: We **never save the user's original file** to the disk. 
*   Instead, the `sharp` library decodes the file into raw pixels in memory, resizes it, and then **re-encodes it into a brand-new JPEG**. During this re-encoding, any appended garbage, polyglot data, or hidden scripts are completely discarded. Only the actual image pixels survive.

#### 2. Scripts in Images (XSS via SVG or EXIF)
Attackers may upload SVGs containing `<script>` tags, or embed JavaScript into EXIF metadata (e.g., the "Camera Model" tag) hoping it executes when viewed.
*   **Mitigation**: 
    *   **No SVGs allowed**: The pre-flight `hasValidImageSignature()` check requires specific raster image magic bytes (`FF D8 FF` for JPEG, `89 50` for PNG, etc.). SVG is XML, so it is rejected instantly. Even if bypassed, `sharp` rejects it as it is not in our `ACCEPTED_SHARP_FORMATS` whitelist.
    *   **EXIF data is destroyed**: When `sharp` outputs the new JPEG, it strips all EXIF metadata by default. Any XSS payloads hidden in tags are completely erased before saving.
    *   **Safe Serving**: The `api/photos/[id]/route.ts` endpoint serves images strictly with the `Content-Type: image/jpeg` header and `Content-Disposition: inline`. Browsers will refuse to execute scripts inside a file served explicitly as a JPEG.

#### 3. Decompression Bombs (DoS)
Attackers might upload a file that is tiny on disk (e.g., a 10KB PNG) but expands to 50,000 x 50,000 pixels, aiming to crash the server by exhausting RAM.
*   **Mitigation**: Before `sharp` attempts to decode the pixel array and resize the image, it reads only the lightweight metadata. We enforce a strict check: `metaWidth * metaHeight > MAX_PIXELS` (capped at 8 Megapixels). If the uncompressed image would be larger, the upload is aborted immediately before allocating memory for the pixels. We also enforce a `MAX_UPLOAD_BYTES` cap (5MB) before parsing starts.

#### 4. Path Traversal & Remote Code Execution (RCE)
Attackers often try to upload files named `../../../etc/passwd` or `shell.php` to overwrite server configuration or run code.
*   **Mitigation**: The filename provided by the client in the `multipart/form-data` payload is **completely ignored**. The `photo-storage.ts` service generates a fresh `crypto.randomUUID()` for every single upload and forces the `.jpg` extension. The file is saved exactly where the server dictates, eliminating any path traversal risk.

### Pipeline Flow (Defense in Depth)

1.  **Client UI**: `<input accept="image/jpeg,image/png,...">` guides the OS file picker.
2.  **Rate Limit**: Capped at 60 uploads / 5 min per user.
3.  **Size Guard**: Rejects payloads > 5MB (`MAX_UPLOAD_BYTES`).
4.  **Magic Byte Guard (Fast)**: `hasValidImageSignature()` inspects the first 12 bytes of the buffer to ensure it starts with a known image signature. Rejects EXEs, PDFs, scripts, and HTML instantly.
5.  **Format Guard (Authoritative)**: `sharp().metadata()` parses the container and rejects anything not in `ACCEPTED_SHARP_FORMATS`.
6.  **Decompression Guard**: Rejects images > 8 Megapixels (`MAX_PIXELS`).
7.  **Sanitization & Re-encoding**: Decodes to pixels, resizes to max 1920px long edge, strips EXIF, and encodes a fresh JPEG byte stream.
8.  **Safe Storage**: Saves to disk using `randomUUID().jpg`.
