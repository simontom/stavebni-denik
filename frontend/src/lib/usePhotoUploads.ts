import { useEffect, useState, useSyncExternalStore } from "react";
import { createPhotoSender, type PhotoUploaded } from "./photoUpload";
import { UploadQueue, type Sender, type UploadSummary } from "./uploadQueue";
import { useUnsavedWork } from "./useUnsavedWork";

/** What the question before leaving the page says while photos are on their way (the page's own words: a photo is not a draft). */
export const PHOTOS_UPLOADING_MESSAGE = "Fotky se ještě nahrávají. Když odejdete, nahrávání se přeruší a zbylé fotky se nenahrají.";

export interface PhotoUploads {
  queue: UploadQueue<PhotoUploaded>;
  /**
   * Whether something is going and how many failed: the same object until one of those changes, **never for progress**. The page reads only
   * this, so it is not drawn again for every event of the browser while a person types in it; the list that shows the progress
   * (`PhotoUploader`) reads the queue's whole state itself.
   */
  summary: UploadSummary;
}

/**
 * The photos of one entry that are being sent (backlog B5): the queue (`uploadQueue.ts`: two requests at a time, a busy server waited for),
 * its summary for the page, and the rule that the upload counts as unsaved work **only while it runs**, so a link, the Back button or logging
 * out asks first ("Fotky se ještě nahrávají") and closing the tab is asked about by the browser. When the page goes away what is on its way
 * is stopped. [onPhoto] is told of every photo as it arrives (the page puts it into its list); [onLost] of a photo whose body had gone out and
 * got no answer: it may be on the server, and the page shows the photos of the entry as they are there.
 */
export function usePhotoUploads({
  projectId,
  reportId,
  onPhoto,
  onLost,
  send,
}: {
  projectId: string;
  reportId: string;
  onPhoto: (photo: PhotoUploaded) => void;
  onLost: () => void;
  /** What sends one photo (the request to the server by default; a test gives its own). */
  send?: Sender<PhotoUploaded>;
}): PhotoUploads {
  const [queue] = useState(() => new UploadQueue<PhotoUploaded>(send ?? createPhotoSender({ projectId, reportId })));
  useEffect(() => queue.setHandlers({ onDone: (_entry, photo) => onPhoto(photo), onLost }), [queue, onPhoto, onLost]);
  const summary = useSyncExternalStore(queue.subscribe, queue.getSummary);
  useUnsavedWork(summary.running, { message: PHOTOS_UPLOADING_MESSAGE });
  useEffect(() => () => queue.abort(), [queue]);
  return { queue, summary };
}
