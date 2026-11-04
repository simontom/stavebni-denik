import { useEffect, useState, useSyncExternalStore } from "react";
import { createPhotoSender, type PhotoUploaded } from "./photoUpload";
import { UploadQueue, type UploadSnapshot } from "./uploadQueue";
import { useUnsavedWork } from "./useUnsavedWork";

/** What the question before leaving the page says while photos are on their way (the page's own words: a photo is not a draft). */
export const PHOTOS_UPLOADING_MESSAGE = "Fotky se ještě nahrávají. Když odejdete, nahrávání se přeruší a zbylé fotky se nenahrají.";

export interface PhotoUploads {
  queue: UploadQueue<PhotoUploaded>;
  snapshot: UploadSnapshot<PhotoUploaded>;
}

/**
 * The photos of one entry that are being sent (backlog B5): the queue (`uploadQueue.ts`: two requests at a time, a busy server waited for),
 * its state for the page, and the rule that the upload counts as unsaved work **only while it runs**, so a link, the Back button or logging
 * out asks first ("Fotky se ještě nahrávají") and closing the tab is asked about by the browser. When the page goes away what is on its way
 * is stopped. [onPhoto] is told of every photo as it arrives (the page puts it into its list).
 */
export function usePhotoUploads({ projectId, reportId, onPhoto }: { projectId: string; reportId: string; onPhoto: (photo: PhotoUploaded) => void }): PhotoUploads {
  const [queue] = useState(() => new UploadQueue<PhotoUploaded>(createPhotoSender({ projectId, reportId })));
  useEffect(() => queue.setOnDone((_entry, photo) => onPhoto(photo)), [queue, onPhoto]);
  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  useUnsavedWork(snapshot.running, { message: PHOTOS_UPLOADING_MESSAGE });
  useEffect(() => () => queue.abort(), [queue]);
  return { queue, snapshot };
}
