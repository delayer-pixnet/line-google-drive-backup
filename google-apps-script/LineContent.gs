function getLineApiHeaders_() {
  return { Authorization: 'Bearer ' + getRequiredProperty_(APP_CONFIG_KEYS_.LINE_CHANNEL_ACCESS_TOKEN) };
}

function downloadLineContent_(messageId) {
  if (typeof messageId !== 'string' || !/^[A-Za-z0-9_-]{5,128}$/.test(messageId)) {
    throw createAppError_('LINE_MESSAGE_ID_INVALID', false, 'LINE 訊息識別資料不正確。');
  }
  // UrlFetchApp 沒有自訂 timeout 參數，實際逾時由 Apps Script 平台強制管理。
  var response = UrlFetchApp.fetch(
    'https://api-data.line.me/v2/bot/message/' + encodeURIComponent(messageId) + '/content',
    { method: 'get', headers: getLineApiHeaders_(), muteHttpExceptions: true }
  );
  var responseCode = response.getResponseCode();
  if (responseCode < 200 || responseCode >= 300) {
    throw createAppError_(
      'LINE_CONTENT_DOWNLOAD_FAILED',
      responseCode === 429 || responseCode >= 500,
      '無法下載 LINE 附件。'
    );
  }
  var headers = response.getHeaders();
  var declaredLength = Number(headers['Content-Length'] || headers['content-length'] || 0);
  var maximum = getMaxFileSizeBytes_();
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    throw createAppError_('FILE_TOO_LARGE', false, '附件超過允許的單檔大小。');
  }
  var blob = response.getBlob();
  var actualLength = blob.getBytes().length;
  if (actualLength > maximum) {
    throw createAppError_('FILE_TOO_LARGE', false, '附件超過允許的單檔大小。');
  }
  return {
    blob: blob,
    contentType: String(headers['Content-Type'] || headers['content-type'] || blob.getContentType() || 'application/octet-stream'),
    byteLength: actualLength
  };
}

function getLineGroupName_(groupId) {
  if (typeof groupId !== 'string' || !/^C[A-Za-z0-9]{5,100}$/.test(groupId)) {
    throw createAppError_('LINE_GROUP_ID_INVALID', false, 'LINE 群組識別資料不正確。');
  }
  var response = UrlFetchApp.fetch(
    'https://api.line.me/v2/bot/group/' + encodeURIComponent(groupId) + '/summary',
    { method: 'get', headers: getLineApiHeaders_(), muteHttpExceptions: true }
  );
  if (response.getResponseCode() !== 200) {
    throw createAppError_('LINE_GROUP_SUMMARY_FAILED', true, '無法取得 LINE 群組名稱。');
  }
  var summary = JSON.parse(response.getContentText());
  return typeof summary.groupName === 'string' && summary.groupName.trim()
    ? summary.groupName.slice(0, 200)
    : '未命名群組';
}
