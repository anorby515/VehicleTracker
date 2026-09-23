/**
 * getFile: streams a Drive file to the app's document viewer and photo
 * headers (docs/API.md "Files").
 *
 * There is NO open file proxy. A file ID is served only when it appears in
 * one of the columns below, read fresh from the Sheet (a positive answer is
 * cached for 5 minutes). Anything else gets 403 forbidden, even if the file
 * exists and the script could open it. The check runs before Drive is touched.
 */

/** Where system file IDs live: [tab, header]. Read by header name. */
function fileIdSources_() {
  return [
    [TAB.DOCUMENTS, 'Drive File ID'],
    [TAB.APP_SCANS, 'Drive File ID'],
    [TAB.VEHICLES, 'Photo File ID'],
    [TAB.VEHICLES, 'Registration File ID'],
  ];
}

const FILE_OK_CACHE_PREFIX_ = 'fileok:';
const FILE_OK_CACHE_SEC_ = 300;
const DRIVE_API_FILES_URL_ = 'https://www.googleapis.com/drive/v3/files/';

/**
 * getFile {fileId, purpose} → FileResult {fileId, name, mimeType, size, data (base64)}.
 * purpose 'photo' returns a Drive thumbnail about RULES.PHOTO_WIDTH px wide
 * when the original image is over RULES.PHOTO_MAX_ORIGINAL_BYTES.
 */
function getFile_(ctx, params) {
  const fileId = String(params.fileId || '').trim();
  if (!fileId || !isSystemFileId_(fileId)) {
    console.warn('getFile refused a file ID that is not part of this system.');
    throw apiError_(403, 'forbidden', "That file isn't part of this app.");
  }

  let file;
  try {
    file = DriveApp.getFileById(fileId);
  } catch (e) {
    throw apiError_(404, 'not_found', "That file isn't in Google Drive any more.");
  }
  if (file.isTrashed()) throw apiError_(404, 'not_found', "That file isn't in Google Drive any more.");

  const size = file.getSize();
  if (size > RULES.FILE_MAX_BYTES) {
    throw apiError_(413, 'too_large', "This file is too big to show in the app. Open it in Google Drive instead.",
      { size: size });
  }
  const name = file.getName();
  const mimeType = file.getMimeType();

  if (params.purpose === 'photo' && /^image\//.test(mimeType) && size > RULES.PHOTO_MAX_ORIGINAL_BYTES) {
    const thumb = fetchThumbnail_(fileId);
    if (thumb) {
      return { fileId: fileId, name: name, mimeType: thumb.mimeType, size: thumb.bytes.length,
        data: Utilities.base64Encode(thumb.bytes) };
    }
    // No thumbnail: fall back to the original (it is still under FILE_MAX_BYTES).
  }

  const bytes = file.getBlob().getBytes();
  return { fileId: fileId, name: name, mimeType: mimeType, size: bytes.length, data: Utilities.base64Encode(bytes) };
}

/** True when the ID is in one of fileIdSources_(). Positive answers are cached for 5 minutes. */
function isSystemFileId_(fileId) {
  const cache = CacheService.getScriptCache();
  const key = FILE_OK_CACHE_PREFIX_ + fileId;
  if (cache.get(key) === '1') return true;
  const ss = openJournal_();
  const found = fileIdSources_().some(src => columnContains_(ss, src[0], src[1], fileId));
  if (found) cache.put(key, '1', FILE_OK_CACHE_SEC_);
  return found;
}

/** Whether a tab's column (found by header name) has a cell equal to `value` (trimmed). */
function columnContains_(ss, tabName, header, value) {
  const sh = ss.getSheetByName(tabName);
  if (!sh) return false;
  const col = headerMap_(sh)[header];
  const lastRow = sh.getLastRow();
  if (!col || lastRow < 2) return false;
  const values = sh.getRange(2, col, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === value) return true;
  }
  return false;
}

/**
 * A Drive thumbnail about RULES.PHOTO_WIDTH px on its long side, or null.
 * Drive API v3 files.get gives a short-lived thumbnailLink ending "=s220";
 * asking for "=s1200" instead returns a bigger rendition. Fetched with the
 * script's OAuth token. Any failure returns null (the caller sends the original).
 */
function fetchThumbnail_(fileId) {
  try {
    const auth = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
    const meta = UrlFetchApp.fetch(DRIVE_API_FILES_URL_ + encodeURIComponent(fileId) + '?fields=thumbnailLink', {
      method: 'get', headers: auth, muteHttpExceptions: true,
    });
    if (meta.getResponseCode() !== 200) return null;
    const link = (JSON.parse(meta.getContentText()) || {}).thumbnailLink;
    if (!link) return null;
    const url = /=s\d+$/.test(link) ? link.replace(/=s\d+$/, '=s' + RULES.PHOTO_WIDTH) : link;
    const res = UrlFetchApp.fetch(url, { method: 'get', headers: auth, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const blob = res.getBlob();
    const type = String(blob.getContentType() || '').split(';')[0].trim();
    const bytes = blob.getBytes();
    if (!/^image\//.test(type) || !bytes || !bytes.length) return null;
    return { mimeType: type, bytes: bytes };
  } catch (e) {
    console.warn('Photo thumbnail failed, sending the original: ' + e);
    return null;
  }
}
