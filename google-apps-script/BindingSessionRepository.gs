var BINDING_SESSION_STATUS_ = Object.freeze({
  PENDING: 'PENDING',
  AUTHORIZED: 'AUTHORIZED',
  PROVISIONING: 'PROVISIONING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
});

var RECOVERABLE_BINDING_SESSION_STATUSES_ = Object.freeze([
  BINDING_SESSION_STATUS_.AUTHORIZED,
  BINDING_SESSION_STATUS_.PROVISIONING,
  BINDING_SESSION_STATUS_.FAILED
]);

var BINDING_PROVISIONING_LEASE_MILLISECONDS_ = 10 * 60 * 1000;

function validateBindingSessionInput_(lineUserHash, bindNonce, expiresAt, allowExpired) {
  if (typeof lineUserHash !== 'string' || !/^[a-f0-9]{64}$/.test(lineUserHash)) {
    throw createAppError_('BIND_SESSION_USER_INVALID', false, '綁定工作階段資料無效。');
  }
  if (typeof bindNonce !== 'string' || !/^[a-f0-9]{16,64}$/.test(bindNonce)) {
    throw createAppError_('BIND_SESSION_NONCE_INVALID', false, '綁定工作階段資料無效。');
  }
  if (!Number.isSafeInteger(expiresAt) || (!allowExpired && expiresAt < Date.now())) {
    throw createAppError_('BIND_SESSION_EXPIRED', false, '綁定工作階段已過期，請回 LINE 重新取得。');
  }
}

/**
 * BindingSessions 與 Nonces 使用相同的用途隔離雜湊，讓授權成功後可只憑安全雜湊恢復，
 * 不必在工作表或管理者恢復流程保存原始 nonce。
 */
function getBindingSessionNonceHash_(bindNonce) {
  return getNonceHash_(bindNonce, 'BIND_TOKEN');
}

function findBindingSessionByNonceHash_(sessionNonceHash) {
  if (typeof sessionNonceHash !== 'string' || !/^[a-f0-9]{64}$/.test(sessionNonceHash)) {
    return null;
  }
  return getSheetRecords_('BindingSessions').find(function (record) {
    return record.SessionNonceHash === sessionNonceHash;
  }) || null;
}

function findBindingSession_(bindNonce) {
  return findBindingSessionByNonceHash_(getBindingSessionNonceHash_(bindNonce));
}

function bindingSessionMatches_(session, lineUserHash, expiresAt) {
  var storedExpiresAt = session ? parseStoredDateMilliseconds_(session.ExpiresAt) : NaN;
  return Boolean(
    session &&
    session.LineUserHash === lineUserHash &&
    Number.isFinite(storedExpiresAt) &&
    Math.abs(storedExpiresAt - expiresAt) <= 1000
  );
}

function assertPendingBindingSession_(lineUserHash, bindNonce, expiresAt) {
  validateBindingSessionInput_(lineUserHash, bindNonce, expiresAt, false);
  var session = findBindingSession_(bindNonce);
  if (
    !bindingSessionMatches_(session, lineUserHash, expiresAt) ||
    session.Status !== BINDING_SESSION_STATUS_.PENDING
  ) {
    throw createAppError_('BIND_SESSION_INVALID', false, '綁定工作階段無效、已完成或已過期。');
  }
  return session;
}

/** 已授權的工作階段可在原 Bind Token 到期後恢復，但仍必須精確符合加密 state。 */
function assertBindingSessionForCallback_(lineUserHash, bindNonce, expiresAt) {
  validateBindingSessionInput_(lineUserHash, bindNonce, expiresAt, true);
  var session = findBindingSession_(bindNonce);
  if (!bindingSessionMatches_(session, lineUserHash, expiresAt)) {
    throw createAppError_('BIND_SESSION_INVALID', false, '綁定工作階段無效。');
  }
  if (session.Status === BINDING_SESSION_STATUS_.COMPLETED) {
    throw createAppError_('BIND_SESSION_COMPLETED', false, '此綁定已完成，請回 LINE 查詢狀態。');
  }
  if (session.Status === BINDING_SESSION_STATUS_.PENDING && expiresAt < Date.now()) {
    throw createAppError_('BIND_SESSION_EXPIRED', false, '綁定工作階段已過期，請回 LINE 重新取得。');
  }
  if (
    session.Status !== BINDING_SESSION_STATUS_.PENDING &&
    RECOVERABLE_BINDING_SESSION_STATUSES_.indexOf(session.Status) < 0
  ) {
    throw createAppError_('BIND_SESSION_INVALID', false, '綁定工作階段狀態無效。');
  }
  return session;
}

function createBindingSession_(lineUserHash, bindNonce, expiresAt, inviteCode) {
  validateBindingSessionInput_(lineUserHash, bindNonce, expiresAt, false);
  var normalizedInviteCode = normalizeInviteCode_(inviteCode);
  if (!normalizedInviteCode && !isSelfServiceBindingEnabled_()) {
    throw createAppError_('INVITATION_INVALID', false, '邀請碼無效、已過期或已達使用次數。');
  }
  var inviteCodeHash = normalizedInviteCode
    ? hashIdentifier_('INVITE:' + normalizedInviteCode)
    : '';
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (inviteCodeHash) {
      var invitation = findInvitationByHash_(inviteCodeHash);
      if (!isInvitationAvailable_(invitation, Date.now())) {
        throw createAppError_('INVITATION_INVALID', false, '邀請碼無效、已過期或已達使用次數。');
      }
    }
    if (findBindingSession_(bindNonce)) {
      throw createAppError_('BIND_SESSION_EXISTS', false, '綁定工作階段已建立，請使用原連結。');
    }
    var createdAt = getTaipeiNow_();
    appendAdminRow_('BindingSessions', [
      getBindingSessionNonceHash_(bindNonce),
      lineUserHash,
      inviteCodeHash,
      new Date(expiresAt),
      '',
      BINDING_SESSION_STATUS_.PENDING,
      createdAt,
      createdAt,
      ''
    ]);
    return true;
  } finally {
    lock.releaseLock();
  }
}

function updateBindingSessionStateWithoutLock_(session, status, failureCode) {
  var safeFailureCode = typeof failureCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(failureCode)
    ? failureCode
    : '';
  getAdminSheet_('BindingSessions')
    .getRange(session._row, 6, 1, 4)
    .setValues([[
      status,
      session.CreatedAt,
      getTaipeiNow_(),
      safeFailureCode
    ]]);
}

function assertNonceHashUnused_(nonceHash) {
  var alreadyUsed = getSheetRecords_('Nonces').some(function (record) {
    return record.NonceHash === nonceHash;
  });
  if (alreadyUsed) {
    throw createAppError_('NONCE_REPLAYED', false, '此請求已處理，請勿重複送出。');
  }
}

function countReservedInvitationUses_(inviteCodeHash) {
  return getSheetRecords_('BindingSessions').filter(function (record) {
    return record.InviteCodeHash === inviteCodeHash &&
      RECOVERABLE_BINDING_SESSION_STATUSES_.indexOf(record.Status) >= 0;
  }).length;
}

function assertInvitationCanBeReserved_(inviteCodeHash) {
  var invitation = findInvitationByHash_(inviteCodeHash);
  if (!isInvitationAvailable_(invitation, Date.now())) {
    throw createAppError_('INVITATION_NO_LONGER_AVAILABLE', false, '邀請碼已失效或已達使用次數。');
  }
  var maximumUses = Number(invitation.MaxUses);
  var usedCount = Number(invitation.UsedCount);
  var reservedCount = countReservedInvitationUses_(inviteCodeHash);
  if (usedCount + reservedCount >= maximumUses) {
    throw createAppError_('INVITATION_NO_LONGER_AVAILABLE', false, '邀請碼已失效或已達使用次數。');
  }
  return invitation;
}

function assertInvitationCanBeCompleted_(inviteCodeHash) {
  var invitation = findInvitationByHash_(inviteCodeHash);
  var maximumUses = invitation ? Number(invitation.MaxUses) : NaN;
  var usedCount = invitation ? Number(invitation.UsedCount) : NaN;
  if (
    !invitation ||
    invitation.Enabled !== true ||
    !Number.isFinite(maximumUses) ||
    !Number.isFinite(usedCount) ||
    maximumUses <= usedCount
  ) {
    throw createAppError_('INVITATION_NO_LONGER_AVAILABLE', false, '邀請碼已停用或已達使用次數。');
  }
  return invitation;
}

function markBindingSessionAuthorized_(lineUserHash, bindNonce, expiresAt) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var session = assertPendingBindingSession_(lineUserHash, bindNonce, expiresAt);
    assertNonceHashUnused_(session.SessionNonceHash);
    // 授權成功時先保留一個名額；FAILED 仍保留，以確保初始化重試不需要新邀請碼。
    if (session.InviteCodeHash) {
      assertInvitationCanBeReserved_(session.InviteCodeHash);
    }
    updateBindingSessionStateWithoutLock_(session, BINDING_SESSION_STATUS_.AUTHORIZED, '');
    return findBindingSessionByNonceHash_(session.SessionNonceHash);
  } finally {
    lock.releaseLock();
  }
}

function beginBindingSessionProvisioning_(lineUserHash, sessionNonceHash) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var session = findBindingSessionByNonceHash_(sessionNonceHash);
    if (!session || session.LineUserHash !== lineUserHash) {
      throw createAppError_('BIND_SESSION_NOT_RECOVERABLE', false, '找不到可恢復的綁定工作階段。');
    }
    if (session.Status === BINDING_SESSION_STATUS_.PROVISIONING) {
      var updatedAt = parseStoredDateMilliseconds_(session.UpdatedAt);
      if (
        Number.isFinite(updatedAt) &&
        Date.now() - updatedAt < BINDING_PROVISIONING_LEASE_MILLISECONDS_
      ) {
        throw createAppError_(
          'BIND_PROVISIONING_IN_PROGRESS',
          true,
          '綁定初始化仍在進行，請稍後再試。'
        );
      }
    } else if (RECOVERABLE_BINDING_SESSION_STATUSES_.indexOf(session.Status) < 0) {
      throw createAppError_('BIND_SESSION_NOT_RECOVERABLE', false, '找不到可恢復的綁定工作階段。');
    }
    assertNonceHashUnused_(session.SessionNonceHash);
    updateBindingSessionStateWithoutLock_(session, BINDING_SESSION_STATUS_.PROVISIONING, '');
    return findBindingSessionByNonceHash_(session.SessionNonceHash);
  } finally {
    lock.releaseLock();
  }
}

function markBindingSessionFailed_(lineUserHash, sessionNonceHash, failureCode) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var session = findBindingSessionByNonceHash_(sessionNonceHash);
    if (!session || session.LineUserHash !== lineUserHash) {
      return false;
    }
    if (session.Status === BINDING_SESSION_STATUS_.COMPLETED) {
      return false;
    }
    if (RECOVERABLE_BINDING_SESSION_STATUSES_.indexOf(session.Status) < 0) {
      return false;
    }
    updateBindingSessionStateWithoutLock_(session, BINDING_SESSION_STATUS_.FAILED, failureCode);
    return true;
  } finally {
    lock.releaseLock();
  }
}

function findRecoverableBindingSessionByUserHash_(lineUserHash) {
  if (typeof lineUserHash !== 'string' || !/^[a-f0-9]{64}$/.test(lineUserHash)) {
    throw createAppError_('BIND_SESSION_USER_INVALID', false, '綁定工作階段資料無效。');
  }
  var sessions = getSheetRecords_('BindingSessions').filter(function (record) {
    return record.LineUserHash === lineUserHash &&
      RECOVERABLE_BINDING_SESSION_STATUSES_.indexOf(record.Status) >= 0;
  });
  sessions.sort(function (left, right) { return right._row - left._row; });
  return sessions.length > 0 ? sessions[0] : null;
}

function validateBindingUserData_(lineUserHash, userData) {
  if (!userData || userData.lineUserHash !== lineUserHash) {
    throw createAppError_('BIND_USER_DATA_INVALID', false, '綁定使用者資料無效。');
  }
  if (
    typeof userData.googleSubjectId !== 'string' || userData.googleSubjectId.length < 1 ||
    userData.googleSubjectId.length > 200 ||
    typeof userData.googleEmail !== 'string' || userData.googleEmail.length < 3 ||
    userData.googleEmail.length > 320
  ) {
    throw createAppError_('BIND_USER_DATA_INVALID', false, '綁定使用者資料無效。');
  }
  ['rootFolderId', 'personalFolderId', 'groupFolderId', 'sheetId'].forEach(function (fieldName) {
    var value = userData[fieldName];
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{5,200}$/.test(value)) {
      throw createAppError_('BIND_RESOURCE_ID_INVALID', false, 'Google 備份資源識別資料無效。');
    }
  });
}

function determineBindingApprovalStatus_(session, existingUser) {
  if (session.InviteCodeHash) {
    return USER_APPROVAL_STATUS_.APPROVED;
  }
  var existingBoundUser = Boolean(existingUser && existingUser.GoogleSubjectId);
  if (isAdminApprovalRequired_() && !existingBoundUser) {
    return USER_APPROVAL_STATUS_.PENDING;
  }
  return existingUser ? getUserApprovalStatus_(existingUser) : USER_APPROVAL_STATUS_.APPROVED;
}

function commitBindingSessionCompletion_(session, invitation, userRow, userValues) {
  var nonceSheet = getAdminSheet_('Nonces');
  var nonceRow = nonceSheet.getLastRow() + 1;
  var usedAt = getTaipeiNow_();
  var spreadsheetId = getAdminSpreadsheet_().getId();
  var data = [
    {
      range: 'BindingSessions!E' + session._row + ':F' + session._row,
      values: [[usedAt, BINDING_SESSION_STATUS_.COMPLETED]]
    },
    {
      range: 'BindingSessions!H' + session._row + ':I' + session._row,
      values: [[usedAt, '']]
    },
    {
      range: 'Nonces!A' + nonceRow + ':D' + nonceRow,
      values: [[
        session.SessionNonceHash,
        'BIND_TOKEN',
        session.ExpiresAt,
        usedAt
      ]]
    },
    {
      range: 'Users!A' + userRow + ':K' + userRow,
      values: [userValues]
    }
  ];
  if (invitation) {
    data.unshift({
      range: 'Invitations!D' + invitation._row,
      values: [[Number(invitation.UsedCount) + 1]]
    });
  }
  var response = UrlFetchApp.fetch(
    'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) +
      '/values:batchUpdate',
    {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({
        valueInputOption: 'RAW',
        data: data
      }),
      muteHttpExceptions: true
    }
  );
  var responseCode = response.getResponseCode();
  if (responseCode < 200 || responseCode >= 300) {
    throw createAppError_('BIND_SESSION_COMMIT_FAILED', true, '無法完成綁定工作階段，請稍後重試。');
  }
}

/** 邀請扣次、Session 完成、nonce 消耗與 Users Enabled 在同一個受鎖批次完成。 */
function completeBindingSession_(lineUserHash, sessionNonceHash, userData) {
  validateBindingUserData_(lineUserHash, userData);
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var session = findBindingSessionByNonceHash_(sessionNonceHash);
    if (
      !session ||
      session.LineUserHash !== lineUserHash ||
      session.Status !== BINDING_SESSION_STATUS_.PROVISIONING
    ) {
      throw createAppError_('BIND_SESSION_NOT_PROVISIONING', false, '綁定工作階段不在可完成狀態。');
    }
    // AUTHORIZED 已保留名額，因此最終完成不再受原邀請碼到期時間影響。
    var invitation = session.InviteCodeHash
      ? assertInvitationCanBeCompleted_(session.InviteCodeHash)
      : null;
    assertNonceHashUnused_(session.SessionNonceHash);

    var existingUser = findUserByHash_(lineUserHash);
    var now = getTaipeiNow_();
    var userRow = existingUser
      ? existingUser._row
      : getAdminSheet_('Users').getLastRow() + 1;
    var approvalStatus = determineBindingApprovalStatus_(session, existingUser);
    var userValues = [
      lineUserHash,
      userData.googleSubjectId,
      userData.googleEmail,
      userData.rootFolderId,
      userData.personalFolderId,
      userData.groupFolderId,
      userData.sheetId,
      approvalStatus === USER_APPROVAL_STATUS_.APPROVED,
      existingUser ? existingUser.CreatedAt : now,
      now,
      approvalStatus
    ];
    commitBindingSessionCompletion_(session, invitation, userRow, userValues);
    return approvalStatus;
  } finally {
    lock.releaseLock();
  }
}
