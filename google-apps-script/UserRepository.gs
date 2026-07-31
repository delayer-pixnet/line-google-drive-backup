var ADMIN_SHEET_HEADERS_ = Object.freeze({
  Users: ['LineUserHash', 'GoogleSubjectId', 'GoogleEmail', 'RootFolderId', 'PersonalFolderId', 'GroupFolderId', 'SheetId', 'Enabled', 'CreatedAt', 'UpdatedAt'],
  Groups: ['GroupIdHash', 'OwnerLineUserHash', 'GroupName', 'FolderId', 'SheetId', 'Enabled', 'CreatedAt', 'UpdatedAt'],
  Invitations: ['InviteCodeHash', 'Enabled', 'MaxUses', 'UsedCount', 'ExpiresAt', 'CreatedAt'],
  Jobs: ['WebhookEventId', 'MessageId', 'Status', 'RetryCount', 'LeaseExpiresAt', 'DriveFileId', 'ErrorCode', 'ErrorMessage', 'CreatedAt', 'UpdatedAt'],
  Nonces: ['NonceHash', 'Purpose', 'ExpiresAt', 'UsedAt'],
  BindingSessions: ['SessionNonceHash', 'LineUserHash', 'InviteCodeHash', 'ExpiresAt', 'UsedAt', 'Status', 'CreatedAt', 'UpdatedAt', 'FailureCode'],
  Errors: ['Timestamp', 'Component', 'ErrorCode', 'SafeMessage', 'CorrelationId']
});

function getAdminSpreadsheet_() {
  return SpreadsheetApp.openById(getRequiredProperty_(APP_CONFIG_KEYS_.ADMIN_SPREADSHEET_ID));
}

function ensureAdminSheets_() {
  var spreadsheet = getAdminSpreadsheet_();
  spreadsheet.setSpreadsheetTimeZone('Asia/Taipei');
  Object.keys(ADMIN_SHEET_HEADERS_).forEach(function (sheetName) {
    var sheet = spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
    var headers = ADMIN_SHEET_HEADERS_[sheetName];
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
    } else {
      var current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
      if (JSON.stringify(current) !== JSON.stringify(headers)) {
        throw createAppError_('ADMIN_HEADERS_MISMATCH', false, '管理試算表欄位不符合版本要求。');
      }
    }
  });
  return spreadsheet;
}

function getAdminSheet_(name) {
  var sheet = getAdminSpreadsheet_().getSheetByName(name);
  if (!sheet) {
    throw createAppError_('ADMIN_SHEET_MISSING', false, '管理試算表尚未初始化。');
  }
  return sheet;
}

function getSheetRecords_(sheetName) {
  var sheet = getAdminSheet_(sheetName);
  var lastRow = sheet.getLastRow();
  var headers = ADMIN_SHEET_HEADERS_[sheetName];
  if (lastRow < 2) {
    return [];
  }
  return sheet.getRange(2, 1, lastRow - 1, headers.length).getValues().map(function (values, index) {
    var record = { _row: index + 2 };
    headers.forEach(function (header, columnIndex) {
      record[header] = values[columnIndex];
    });
    return record;
  });
}

function appendAdminRow_(sheetName, values) {
  getAdminSheet_(sheetName).appendRow(values);
}

function findUserByHash_(lineUserHash) {
  return getSheetRecords_('Users').find(function (record) {
    return record.LineUserHash === lineUserHash;
  }) || null;
}

function findEnabledUserByHash_(lineUserHash) {
  var user = findUserByHash_(lineUserHash);
  return user && user.Enabled === true ? user : null;
}

function upsertUser_(userData) {
  var sheet = getAdminSheet_('Users');
  var existing = findUserByHash_(userData.lineUserHash);
  var now = getTaipeiNow_();
  var values = [
    userData.lineUserHash,
    userData.googleSubjectId,
    userData.googleEmail,
    userData.rootFolderId,
    userData.personalFolderId,
    userData.groupFolderId,
    userData.sheetId,
    true,
    existing ? existing.CreatedAt : now,
    now
  ];
  if (existing) {
    sheet.getRange(existing._row, 1, 1, values.length).setValues([values]);
  } else {
    sheet.appendRow(values);
  }
}

function disableUser_(lineUserHash) {
  var existing = findUserByHash_(lineUserHash);
  if (!existing) {
    return false;
  }
  var sheet = getAdminSheet_('Users');
  sheet.getRange(existing._row, 8).setValue(false);
  sheet.getRange(existing._row, 10).setValue(getTaipeiNow_());
  return true;
}
