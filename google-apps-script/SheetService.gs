var BACKUP_SHEET_HEADERS_ = Object.freeze([
  'LINE 訊息時間', '備份完成時間', '來源類型', '群組名稱', '群組識別', '傳送者識別', '傳送者名稱', '訊息類型',
  '原始檔名', '文字內容', '網址', '標籤', 'Drive File ID', 'Drive 連結',
  'webhookEventId', 'messageId', '狀態', '錯誤訊息'
]);

function getSheetColumnLetter_(columnNumber) {
  var number = Number(columnNumber);
  var result = '';
  while (number > 0) {
    var remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }
  return result || 'A';
}

function sanitizeDisplayNameForSheet_(value, fallback) {
  var normalized = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100)
    : '';
  if (!normalized) {
    normalized = fallback === undefined ? 'unknown_user' : String(fallback);
  }
  if (!normalized) {
    return '';
  }
  return /^[=+\-@]/.test(normalized) ? "'" + normalized : normalized;
}

function getBackupSheetHeaders_(accessToken, spreadsheetId) {
  var response = googleApiFetch_(
    'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) +
      '/values/' + encodeURIComponent('備份紀錄!1:1'),
    { method: 'get' },
    accessToken,
    'SHEET_HEADERS_READ_FAILED'
  );
  var result = parseJsonResponse_(response, 'SHEET_HEADERS_RESPONSE_INVALID');
  var values = Array.isArray(result.values) && Array.isArray(result.values[0])
    ? result.values[0]
    : [];
  return values.map(function (value) { return String(value || '').trim(); });
}

/** 新 Sheet 使用標準順序；舊 Sheet 只在最右側補缺少的標題，絕不重排或清空資料。 */
function ensureBackupSheetHeaders_(accessToken, spreadsheetId) {
  var headers = getBackupSheetHeaders_(accessToken, spreadsheetId);
  if (headers.length === 0) {
    updateSheetValues_(
      accessToken,
      spreadsheetId,
      '備份紀錄!A1:' + getSheetColumnLetter_(BACKUP_SHEET_HEADERS_.length) + '1',
      [BACKUP_SHEET_HEADERS_]
    );
    return BACKUP_SHEET_HEADERS_.slice();
  }
  getMissingBackupSheetHeaders_(headers).forEach(function (header) {
    headers.push(header);
    var cell = '備份紀錄!' + getSheetColumnLetter_(headers.length) + '1';
    updateSheetValues_(accessToken, spreadsheetId, cell, [[header]]);
  });
  return headers;
}

function getMissingBackupSheetHeaders_(headers) {
  var existing = Array.isArray(headers) ? headers : [];
  return BACKUP_SHEET_HEADERS_.filter(function (header) {
    return existing.indexOf(header) < 0;
  });
}

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
  updateSheetValues_(
    accessToken,
    result.spreadsheetId,
    '備份紀錄!A1:' + getSheetColumnLetter_(BACKUP_SHEET_HEADERS_.length) + '1',
    [BACKUP_SHEET_HEADERS_]
  );
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
  // 若前次執行在建檔後中止，重試會找到同一份 Sheet 並補齊標頭，不重排舊資料。
  ensureBackupSheetHeaders_(accessToken, spreadsheetId);
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
  var headers = ensureBackupSheetHeaders_(accessToken, spreadsheetId);
  var row = buildBackupRecordRowByHeaders_(headers, record);
  googleApiFetch_(
    'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) +
      '/values/' + encodeURIComponent('備份紀錄!A:' + getSheetColumnLetter_(headers.length)) +
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

function buildBackupRecordRowByHeaders_(headers, record) {
  var values = {
    'LINE 訊息時間': formatTaipeiTime_(record.messageTimestamp),
    '備份完成時間': getTaipeiNow_(),
    '來源類型': record.sourceType,
    '群組名稱': sanitizeDisplayNameForSheet_(record.groupName, ''),
    '群組識別': /^[a-f0-9]{64}$/.test(String(record.groupHash || '')) ? String(record.groupHash) : '',
    '傳送者識別': record.senderHash,
    '傳送者名稱': sanitizeDisplayNameForSheet_(record.senderDisplayName, 'unknown_user'),
    '訊息類型': record.messageType,
    '原始檔名': record.originalFileName || '',
    '文字內容': record.rawText || '',
    '網址': (record.urls || []).join('\n'),
    '標籤': (record.tags || []).join(', '),
    'Drive File ID': record.driveFileId || '',
    'Drive 連結': record.driveLink || '',
    'webhookEventId': record.webhookEventId,
    'messageId': record.messageId || '',
    '狀態': record.status,
    '錯誤訊息': record.errorMessage || ''
  };
  var row = headers.map(function (header) {
    return Object.prototype.hasOwnProperty.call(values, header) ? values[header] : '';
  });
  return row;
}

function markBackupRecordUnsent_(accessToken, spreadsheetId, messageId) {
  var headers = ensureBackupSheetHeaders_(accessToken, spreadsheetId);
  var response = googleApiFetch_(
    'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) +
      '/values/' + encodeURIComponent('備份紀錄!A:' + getSheetColumnLetter_(headers.length)),
    { method: 'get' }, accessToken, 'SHEET_READ_FAILED'
  );
  var result = parseJsonResponse_(response, 'SHEET_READ_RESPONSE_INVALID');
  var rows = Array.isArray(result.values) ? result.values : [];
  var messageIdIndex = headers.indexOf('messageId');
  var statusIndex = headers.indexOf('狀態');
  var errorIndex = headers.indexOf('錯誤訊息');
  if (messageIdIndex < 0 || statusIndex < 0 || errorIndex < 0) {
    return false;
  }
  for (var index = 1; index < rows.length; index += 1) {
    if (rows[index][messageIdIndex] === messageId) {
      updateSheetValues_(
        accessToken,
        spreadsheetId,
        '備份紀錄!' + getSheetColumnLetter_(statusIndex + 1) + (index + 1),
        [['已收回']]
      );
      updateSheetValues_(
        accessToken,
        spreadsheetId,
        '備份紀錄!' + getSheetColumnLetter_(errorIndex + 1) + (index + 1),
        [['訊息已由傳送者收回。']]
      );
      return true;
    }
  }
  return false;
}
