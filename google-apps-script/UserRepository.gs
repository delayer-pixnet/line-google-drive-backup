var USER_APPROVAL_STATUS_ = Object.freeze({
  PENDING: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED'
});

var ADMIN_SHEET_HEADERS_ = Object.freeze({
  Users: ['LineUserHash', 'GoogleSubjectId', 'GoogleEmail', 'RootFolderId', 'PersonalFolderId', 'GroupFolderId', 'SheetId', 'Enabled', 'CreatedAt', 'UpdatedAt', 'ApprovalStatus'],
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
    if (sheetName === 'Users') {
      migrateUsersApprovalStatusColumn_(sheet);
    }
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

function migrateUsersApprovalStatusColumn_(sheet) {
  var headers = ADMIN_SHEET_HEADERS_.Users;
  var legacyHeaders = headers.slice(0, 10);
  if (sheet.getLastRow() === 0) {
    return;
  }
  var current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var legacyMatches = JSON.stringify(current.slice(0, 10)) === JSON.stringify(legacyHeaders);
  if (!legacyMatches) {
    return;
  }
  if (current[10] !== headers[10]) {
    sheet.getRange(1, 11).setValue(headers[10]);
  }
  var rowCount = sheet.getLastRow() - 1;
  if (rowCount <= 0) {
    return;
  }
  var enabledValues = sheet.getRange(2, 8, rowCount, 1).getValues();
  var approvalRange = sheet.getRange(2, 11, rowCount, 1);
  var approvalValues = approvalRange.getValues();
  var changed = false;
  approvalValues.forEach(function (row, index) {
    if (!row[0]) {
      row[0] = enabledValues[index][0] === true ? USER_APPROVAL_STATUS_.APPROVED : USER_APPROVAL_STATUS_.REJECTED;
      changed = true;
    }
  });
  if (changed) {
    approvalRange.setValues(approvalValues);
  }
}

function getAdminSheet_(name) {
  var sheet = getAdminSpreadsheet_().getSheetByName(name);
  if (!sheet) {
    throw createAppError_('ADMIN_SHEET_MISSING', false, '管理試算表尚未初始化。');
  }
  if (name === 'Users') {
    migrateUsersApprovalStatusColumn_(sheet);
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
  return isApprovedEnabledUser_(user) ? user : null;
}

function getUserApprovalStatus_(user) {
  if (!user) {
    return null;
  }
  if (user.ApprovalStatus === USER_APPROVAL_STATUS_.APPROVED) {
    return USER_APPROVAL_STATUS_.APPROVED;
  }
  if (user.ApprovalStatus === USER_APPROVAL_STATUS_.PENDING) {
    return USER_APPROVAL_STATUS_.PENDING;
  }
  if (user.ApprovalStatus === USER_APPROVAL_STATUS_.REJECTED) {
    return USER_APPROVAL_STATUS_.REJECTED;
  }
  // 舊版 Users 沒有 ApprovalStatus；Enabled=true 的既有使用者視為已核准。
  return isEnabledUserValue_(user.Enabled)
    ? USER_APPROVAL_STATUS_.APPROVED
    : USER_APPROVAL_STATUS_.REJECTED;
}

function isEnabledUserValue_(value) {
  return value === true || value === 1 ||
    (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

function getUserBindingState_(lineUserHash) {
  var user = findUserByHash_(lineUserHash);
  return {
    user: user,
    hasUser: Boolean(user),
    enabled: Boolean(user && isEnabledUserValue_(user.Enabled)),
    approvalStatus: getUserApprovalStatus_(user)
  };
}

function isApprovedEnabledUser_(user) {
  return Boolean(
    user &&
    isEnabledUserValue_(user.Enabled) &&
    getUserApprovalStatus_(user) === USER_APPROVAL_STATUS_.APPROVED
  );
}

/** 管理者手動執行；補齊舊版 Enabled=true 使用者的核准狀態，不修改其他資料。 */
function migrateEnabledUsersToApproved() {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var spreadsheet = getAdminSpreadsheet_();
    var sheet = spreadsheet.getSheetByName('Users');
    if (!sheet) {
      throw createAppError_('ADMIN_SHEET_MISSING', false, '管理試算表尚未初始化。');
    }
    var lastColumn = Math.max(sheet.getLastColumn(), ADMIN_SHEET_HEADERS_.Users.length);
    var headerValues = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
    var approvalColumn = headerValues.indexOf('ApprovalStatus') + 1;
    if (approvalColumn === 0) {
      // getLastColumn() 可能包含為了相容性預留的空白欄；優先填入第一個空標題，避免多插一欄。
      var firstEmptyHeader = headerValues.indexOf('');
      approvalColumn = firstEmptyHeader >= 0 ? firstEmptyHeader + 1 : headerValues.length + 1;
      sheet.getRange(1, approvalColumn).setValue('ApprovalStatus');
      headerValues[approvalColumn - 1] = 'ApprovalStatus';
    }
    var enabledColumn = headerValues.indexOf('Enabled') + 1;
    if (enabledColumn === 0) {
      throw createAppError_('ADMIN_HEADERS_MISMATCH', false, 'Users 欄位尚未初始化。');
    }
    var rowCount = Math.max(0, sheet.getLastRow() - 1);
    var updates = [];
    if (rowCount > 0) {
      var rows = sheet.getRange(2, 1, rowCount, Math.max(approvalColumn, enabledColumn)).getValues();
      rows.forEach(function (row, index) {
        var approvalValue = row[approvalColumn - 1];
        if (!approvalValue && isEnabledUserValue_(row[enabledColumn - 1])) {
          updates.push(index + 2);
        }
      });
    }
    Logger.log('migrateEnabledUsersToApproved 開始：預計更新 ' + updates.length + ' 筆。');
    updates.forEach(function (rowNumber) {
      sheet.getRange(rowNumber, approvalColumn).setValue(USER_APPROVAL_STATUS_.APPROVED);
    });
    Logger.log('migrateEnabledUsersToApproved 完成：更新 ' + updates.length + ' 筆。');
    return updates.length;
  } finally {
    lock.releaseLock();
  }
}

function getUserReviewCode_(lineUserHash) {
  if (typeof lineUserHash !== 'string' || !/^[a-f0-9]{64}$/.test(lineUserHash)) {
    throw createAppError_('USER_REVIEW_CODE_INVALID', false, '審核代號無效。');
  }
  return 'U' + lineUserHash.slice(0, 8).toUpperCase();
}

function isPendingApprovalUser_(user) {
  return Boolean(
    user &&
    user.Enabled === false &&
    getUserApprovalStatus_(user) === USER_APPROVAL_STATUS_.PENDING
  );
}

function assertAdminUser_(lineUserHash) {
  if (!isAdminLineUserHash_(lineUserHash)) {
    throw createAppError_('ADMIN_ONLY', false, '只有管理者可以執行此指令。');
  }
}

function listPendingApprovalUsers_() {
  var pendingUsers = getPendingApprovalUsers_();
  if (pendingUsers.length === 0) {
    return '目前沒有待審核使用者。';
  }
  var lines = ['待審核使用者：'];
  pendingUsers.slice(0, 20).forEach(function (user, index) {
    lines.push((index + 1) + '. ' + getUserReviewCode_(user.LineUserHash) + '（建立：' + String(user.CreatedAt || '未知') + '）');
  });
  if (pendingUsers.length > 20) {
    lines.push('其餘項目請稍後再查詢。');
  }
  return lines.join('\n');
}

function getPendingApprovalUsers_() {
  return getSheetRecords_('Users').filter(isPendingApprovalUser_);
}

function parseApprovalTargetTokens_(argument) {
  if (typeof argument !== 'string' || !argument.trim()) {
    throw createAppError_('USER_REVIEW_TARGET_INVALID', false, '請提供審核編號。');
  }
  var tokens = argument.split(',').map(function (value) { return value.trim().toUpperCase(); });
  if (
    tokens.length === 0 ||
    tokens.length > 100 ||
    tokens.some(function (token) {
      return !/^\d{1,4}$/.test(token) && !/^U[A-F0-9]{8}$/.test(token);
    })
  ) {
    throw createAppError_('USER_REVIEW_TARGET_INVALID', false, '審核編號格式無效。');
  }
  return tokens;
}

function resolveApprovalTargets_(argument, pendingUsers) {
  var users = Array.isArray(pendingUsers) ? pendingUsers : getPendingApprovalUsers_();
  var tokens = parseApprovalTargetTokens_(argument);
  var targets = [];
  var skipped = 0;
  var seenRows = {};
  tokens.forEach(function (token) {
    var user = null;
    if (/^\d{1,4}$/.test(token)) {
      var index = Number(token) - 1;
      user = index >= 0 && index < users.length ? users[index] : null;
    } else {
      var matches = users.filter(function (candidate) {
        return getUserReviewCode_(candidate.LineUserHash) === token;
      });
      user = matches.length === 1 ? matches[0] : null;
    }
    if (!user || seenRows[user._row]) {
      skipped += 1;
      return;
    }
    seenRows[user._row] = true;
    targets.push(user);
  });
  return { targets: targets, skipped: skipped };
}

function applyApprovalUpdates_(targets, approvalStatus) {
  if (!Array.isArray(targets)) {
    throw createAppError_('USER_REVIEW_TARGET_INVALID', false, '審核對象無效。');
  }
  if ([USER_APPROVAL_STATUS_.APPROVED, USER_APPROVAL_STATUS_.REJECTED].indexOf(approvalStatus) < 0) {
    throw createAppError_('USER_APPROVAL_STATUS_INVALID', false, '審核狀態無效。');
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var currentUsers = getSheetRecords_('Users');
    var sheet = getAdminSheet_('Users');
    var result = { succeeded: 0, skipped: 0, failed: 0 };
    targets.forEach(function (target) {
      var current = currentUsers.find(function (user) { return user._row === target._row; });
      if (!isPendingApprovalUser_(current)) {
        result.skipped += 1;
        return;
      }
      try {
        sheet.getRange(current._row, 8, 1, 4).setValues([[
          approvalStatus === USER_APPROVAL_STATUS_.APPROVED,
          current.CreatedAt,
          getTaipeiNow_(),
          approvalStatus
        ]]);
        result.succeeded += 1;
      } catch (error) {
        result.failed += 1;
        safeLog_('error', 'approval', 'USER_APPROVAL_UPDATE_FAILED', 'approval-batch');
      }
    });
    return result;
  } finally {
    lock.releaseLock();
  }
}

function getApprovalConfirmationPropertyKey_(lineUserHash) {
  if (typeof lineUserHash !== 'string' || !/^[a-f0-9]{64}$/.test(lineUserHash)) {
    throw createAppError_('ADMIN_ONLY', false, '管理者識別無效。');
  }
  return 'APPROVAL_CONFIRMATION_' + lineUserHash;
}

function createApprovalConfirmation_(lineUserHash, operation) {
  if (
    !isAdminLineUserHashConfigured_(lineUserHash, getAdminLineUserHashes_()) ||
    ['APPROVE_ALL', 'REJECT_ALL'].indexOf(operation) < 0
  ) {
    throw createAppError_('ADMIN_ONLY', false, '只有管理者可以執行此指令。');
  }
  var code = Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
  var record = {
    operation: operation,
    expiresAt: Date.now() + 5 * 60 * 1000,
    codeHash: hashIdentifier_('APPROVAL_CONFIRM:' + lineUserHash + ':' + code)
  };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    PropertiesService.getScriptProperties().setProperty(
      getApprovalConfirmationPropertyKey_(lineUserHash),
      JSON.stringify(record)
    );
  } finally {
    lock.releaseLock();
  }
  return { code: code, expiresAt: record.expiresAt };
}

function isApprovalConfirmationValid_(record, lineUserHash, operation, code, nowMilliseconds) {
  var now = Number.isFinite(nowMilliseconds) ? nowMilliseconds : Date.now();
  if (
    !record ||
    record.operation !== operation ||
    typeof record.codeHash !== 'string' ||
    !/^\d{13}$/.test(String(record.expiresAt)) ||
    Number(record.expiresAt) <= now ||
    typeof code !== 'string' ||
    !/^[A-F0-9]{8}$/.test(code)
  ) {
    return false;
  }
  return constantTimeEqual_(
    record.codeHash,
    hashIdentifier_('APPROVAL_CONFIRM:' + lineUserHash + ':' + code)
  );
}

function consumeApprovalConfirmation_(lineUserHash, operation, code) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var properties = PropertiesService.getScriptProperties();
    var propertyKey = getApprovalConfirmationPropertyKey_(lineUserHash);
    var raw = properties.getProperty(propertyKey);
    var record = null;
    try {
      record = raw ? JSON.parse(raw) : null;
    } catch (error) {
      record = null;
    }
    if (!isApprovalConfirmationValid_(record, lineUserHash, operation, code)) {
      throw createAppError_('APPROVAL_CONFIRMATION_INVALID', false, '確認碼無效、已過期或不屬於目前管理者。');
    }
    properties.deleteProperty(propertyKey);
    return true;
  } finally {
    lock.releaseLock();
  }
}

function updateUserApprovalByReviewCode_(reviewCode, approvalStatus) {
  if (typeof reviewCode !== 'string' || !/^U[A-F0-9]{8}$/.test(reviewCode.trim().toUpperCase())) {
    throw createAppError_('USER_REVIEW_CODE_INVALID', false, '審核代號格式無效。');
  }
  if ([USER_APPROVAL_STATUS_.APPROVED, USER_APPROVAL_STATUS_.REJECTED].indexOf(approvalStatus) < 0) {
    throw createAppError_('USER_APPROVAL_STATUS_INVALID', false, '審核狀態無效。');
  }
  var normalizedCode = reviewCode.trim().toUpperCase();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var matches = getSheetRecords_('Users').filter(function (user) {
      return isPendingApprovalUser_(user) &&
        getUserReviewCode_(user.LineUserHash) === normalizedCode;
    });
    if (matches.length !== 1) {
      throw createAppError_('USER_REVIEW_NOT_FOUND', false, '找不到唯一的待審核使用者。');
    }
    var user = matches[0];
    var sheet = getAdminSheet_('Users');
    sheet.getRange(user._row, 8).setValue(approvalStatus === USER_APPROVAL_STATUS_.APPROVED);
    sheet.getRange(user._row, 10).setValue(getTaipeiNow_());
    sheet.getRange(user._row, 11).setValue(approvalStatus);
    return approvalStatus;
  } finally {
    lock.releaseLock();
  }
}

function upsertUser_(userData) {
  var sheet = getAdminSheet_('Users');
  var existing = findUserByHash_(userData.lineUserHash);
  var now = getTaipeiNow_();
  var approvalStatus = userData.approvalStatus || (existing ? getUserApprovalStatus_(existing) : USER_APPROVAL_STATUS_.APPROVED);
  var enabled = approvalStatus === USER_APPROVAL_STATUS_.APPROVED &&
    (userData.enabled === undefined || userData.enabled === true);
  var values = [
    userData.lineUserHash,
    userData.googleSubjectId,
    userData.googleEmail,
    userData.rootFolderId,
    userData.personalFolderId,
    userData.groupFolderId,
    userData.sheetId,
    enabled,
    existing ? existing.CreatedAt : now,
    now,
    approvalStatus
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
