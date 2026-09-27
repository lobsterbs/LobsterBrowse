/* Local module marker; the global JSX augmentation lives in m3e.d.ts. */
/* Minimal File System Access API surface used by downloads
   (showSaveFilePicker streaming). Declared here instead of lib.dom
   tweaks so the fallback path compiles in browsers without the API.
   Keep local and structural: no global augmentation surprises. */
type FileSystemWritableFileStreamLike = {
  write(data: BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
};

interface Window {
  showSaveFilePicker?(options?: { suggestedName?: string }): Promise<{
    createWritable(): Promise<FileSystemWritableFileStreamLike>;
  }>;
}

export {};
