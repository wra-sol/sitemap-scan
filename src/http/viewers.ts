import { DIFF_VIEWER_HTML } from './viewers/diff-viewer-template';
import { BACKUP_VIEWER_HTML } from './viewers/backup-viewer-template';

export async function serveDiffViewer(): Promise<Response> {
  return new Response(DIFF_VIEWER_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

export async function serveBackupViewer(): Promise<Response> {
  return new Response(BACKUP_VIEWER_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
