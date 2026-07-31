var BACKUP_SHEET_HEADERS_ = Object.freeze([
  'LINE 訊息時間', '備份完成時間', '來源類型', '群組名稱', '傳送者識別', '訊息類型',
  '原始檔名', '文字內容', '網址', '標籤', 'Drive File ID', 'Drive 連結',
  'webhookEventId', 'messageId', '狀態', '錯誤訊息'
]);

function createBackupSpreadsheet_(accessToken, rootFolderId) {
  var response = googleApiFetch_(
    'https://sheets.googleapis.com/v4/spreadsheets',
    {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      payload: JSON.stringify({
        properties: { title: 'LINE 備份紀錄' },
        sheets: [{ properties: { title: '備份紀錄', frozenRowCount: 1 } }]
      })
    },
    accessToken,
    'SHEET_CREATE_FAILED'
  );
  var result = parseJsonResponse_(response, 'SHEET_CREATE_RESPONSE_INVALID');
  if (typeof result.spreadsheetId !== 'string') {
    throw createAppError_('SHEET_ID_MISSING', true, 'Google Sheets 未回傳試算表識別碼。');
  }
  googleApiFetch_(
    'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(result.spreadsheetId) +
      '?addParents=' + encodeURIComponent(rootFolderId) + '&removeParents=root&fields=id,parents',
    { method: 'patch', contentType: 'application/json', payload: '{}' },
    accessToken,
    'SHEET_MOVE_FAILED'
  );
  updateSheetValues_(accessToken, result.spreadsheetId, '備份紀錄!A1:P1', [BACKUP_SHEET_HEADERS_]);
  return result.spreadsheetId;
}

function ensureBackupSpreadsheet_(accessToken, rootFolderId, resourceKey) {
  var existing = findDriveItemByAppProperty_(
    accessToken,
    'lineBackupResourceKey',
    resourceKey,
    rootFolderId,
    'application/vnd.google-apps.spreadsheet'
  );
  var spreadsheetId;
  if (existing) {
    spreadsheetId = existing.id;
  } else {
    var response = googleApiFetch_(
      'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink',
      {
        method: 'post',
        contentType: 'application/json; charset=utf-8',
        payload: JSON.stringify({
          name: 'LINE 備份紀錄',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          parents: [rootFolderId],
          appProperties: { lineBackupResourceKey: resourceKey }
        })
      },
      accessToken,
      'SHEET_CREATE_FAILED'
    );
    var result = parseJsonResponse_(response, 'SHEET_CREATE_RESPONSE_INVALID');
    if (typeof result.id !== 'string') {
      throw createAppError_('SHEET_ID_MISSING', true, 'Google Sheets 未回傳試算表識別碼。');
    }
    spreadsheetId = result.id;
  }
  ensureBackupSheetTab_(accessToken, spreadsheetId);
  // 若前次執行在建檔後中止，重試會找到同一份 Sheet 並補齊標頭。
  updateSheetValues_(accessToken, spreadsheetId, '備份紀錄!A1:P1', [BACKUP_SHEET_HEADERS_]);
  return spreadsheetId;
}

function ensureBackupSheetTab_(accessToken, spreadsheetId) {
  var response = googleApiFetch_(
    'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) +
      '?fields=sheets.properties(sheetId,title)',
    { method: 'get' },
    accessToken,
    'SHEET_METADATA_READ_FAILED'
  );
  var metadata = parseJsonResponse_(response, 'SHEET_METADATA_RESPONSE_INVALID');
  var sheets = Array.isArray(metadata.sheets) ? metadata.sheets : [];
  var hasBackupSheet = sheets.some(function (sheet) {
    return sheet && sheet.properties && sheet.properties.title === '備份紀錄';
  });
  if (hasBackupSheet) {
    return;
  }
  var firstSheetId = sheets[0] && sheets[0].properties
    ? sheets[0].properties.sheetId
    : null;
  if (!Number.isSafeInteger(firstSheetId)) {
    throw createAppError_('SHEET_TAB_MISSING', true, 'Google Sheets 未提供預設工作表。');
  }
  googleApiFetch_(
    'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) + ':batchUpdate',
    {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      payload: JSON.stringify({
        requests: [{
          updateSheetProperties: {
            properties: { sheetId: firstSheetId, title: '備份紀錄', gridProperties: { frozenRowCount: 1 } },
            fields: 'title,gridProperties.frozenRowCount'
          }
        }]
      })
    },
    accessToken,
    'SHEET_TAB_INITIALIZE_FAILED'
  );
}

function updateSheetValues_(accessToken, spreadsheetId, range, values) {
  googleApiFetch_(
    'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) +
      '/values/' + encodeURIComponent(range) + '?valueInputOption=RAW',
    {
      method: 'put',
      contentType: 'application/json; charset=utf-8',
      payload: JSON.stringify({ range: range, majorDimension: 'ROWS', values: values })
    },
    accessToken,
    'SHEET_UPDATE_FAILED'
  );
}

function appendBackupRecord_(accessToken, spreadsheetId, record) {
  var row = [
    formatTaipeiTime_(record.messageTimestamp),
    getTaipeiNow_(),
    record.sourceType,
    record.groupName || '',
    record.senderHash,
    record.messageType,
    record.originalFileName || '',
    record.rawText || '',
    (record.urls || []).join('\n'),
    (record.tags || []).join(', '),
    record.driveFileId || '',
    record.driveLink || '',
    record.webhookEventId,
    record.messageId || '',
    record.status,
    record.errorMessage || ''
  ];
  googleApiFetch_(
    'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) +
      '/values/' + encodeURIComponent('備份紀錄!A:P') +
      ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
    {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      payload: JSON.stringify({ majorDimension: 'ROWS', values: [row] })
    },
    accessToken,
    'SHEET_APPEND_FAILED'
  );
}

function markBackupRecordUnsent_(accessToken, spreadsheetId, messageId) {
  var response = googleApiFetch_(
    'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) +
      '/values/' + encodeURIComponent('備份紀錄!A:P'),
    { method: 'get' },
    accessToken,
    'SHEET_READ_FAILED'
  );
  var result = parseJsonResponse_(response, 'SHEET_READ_RESPONSE_INVALID');
  var rows = Array.isArray(result.values) ? result.values : [];
  for (var index = 1; index < rows.length; index += 1) {
    if (rows[index][13] === messageId) {
      updateSheetValues_(accessToken, spreadsheetId, '備份紀錄!O' + (index + 1) + ':P' + (index + 1), [[
        '已收回', '訊息已由傳送者收回。'
      ]]);
      return true;
    }
  }
  return false;
}
