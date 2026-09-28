export interface DownloadableExport {
  blob: Blob;
  format: string;
}

export function downloadExport(result: DownloadableExport, fileName = `document.${result.format === 'jpeg' ? 'jpg' : result.format}`): void {
  const url = URL.createObjectURL(result.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
