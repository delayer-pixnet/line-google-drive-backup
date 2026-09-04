function provisionAuthorizedBinding_(lineUserHash, session) {
  var provisioningSession = beginBindingSessionProvisioning_(
    lineUserHash,
    session.SessionNonceHash
  );
  try {
    var service = getGoogleOAuthService_(lineUserHash);
    if (!service.hasAccess()) {
      throw createAppError_('OAUTH_NOT_BOUND', false, getOAuthTokenExpiredMessage_());
    }
    var accessToken = service.getAccessToken();
    var profile = getGoogleUserProfile_(accessToken);
    var existing = findUserByHash_(lineUserHash);
    var isExistingUserReauthorization = Boolean(
      !session.InviteCodeHash && existing && existing.GoogleSubjectId
    );
    if (isExistingUserReauthorization && existing.GoogleSubjectId !== profile.sub) {
      throw createAppError_('OAUTH_REAUTH_ACCOUNT_MISMATCH', false, '請使用原本綁定的 Google 帳號完成重新授權。');
    }
    var reusableExisting = existing && existing.GoogleSubjectId === profile.sub ? existing : null;
    var resources = hasCompleteUserResources_(reusableExisting)
      ? {
          rootFolderId: reusableExisting.RootFolderId,
          personalFolderId: reusableExisting.PersonalFolderId,
          groupFolderId: reusableExisting.GroupFolderId,
          sheetId: reusableExisting.SheetId
        }
      : ensureUserResources_(accessToken, lineUserHash, reusableExisting);

    if (existing && existing.GoogleSubjectId !== profile.sub) {
      // 新 Google 帳號無法存取舊帳號資源；先停用既有群組，再於最終批次啟用新帳號。
      disableGroupsOwnedBy_(lineUserHash);
    }

    var approvalStatus = completeBindingSession_(lineUserHash, provisioningSession.SessionNonceHash, {
      lineUserHash: lineUserHash,
      googleSubjectId: profile.sub,
      googleEmail: profile.email,
      rootFolderId: resources.rootFolderId,
      personalFolderId: resources.personalFolderId,
      groupFolderId: resources.groupFolderId,
      sheetId: resources.sheetId
    });
    return { completed: true, approvalStatus: approvalStatus };
  } catch (error) {
    var appError = isAppError_(error)
      ? error
      : createAppError_('BIND_PROVISIONING_FAILED', true, 'Google 備份空間初始化失敗，請稍後重試。');
    markBindingSessionFailed_(lineUserHash, provisioningSession.SessionNonceHash, appError.appCode);
    safeLog_(
      'error',
      'binding-recovery',
      appError.appCode,
      appError.correlationId || 'binding-recovery'
    );
    throw appError;
  }
}

function assertRecoveryLineUserHash_(lineUserHash) {
  if (typeof lineUserHash !== 'string' || !/^[a-f0-9]{64}$/.test(lineUserHash)) {
    throw createAppError_(
      'BIND_RECOVERY_USER_INVALID',
      false,
      '請提供有效的 LINE 使用者雜湊。'
    );
  }
  return lineUserHash;
}

function markUnfinishedBindingSessionsFailedForReset_(lineUserHash) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var updatedCount = 0;
    getSheetRecords_('BindingSessions').forEach(function (session) {
      if (session.LineUserHash === lineUserHash && session.Status !== BINDING_SESSION_STATUS_.COMPLETED) {
        updateBindingSessionStateWithoutLock_(
          session,
          BINDING_SESSION_STATUS_.FAILED,
          'OAUTH_TOKEN_RESET_FOR_REBIND'
        );
        updatedCount += 1;
      }
    });
    return updatedCount;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 測試部署期由管理者手動執行；只清除指定雜湊使用者的 OAuth Token，
 * 不刪除 Users、Groups、Invitations 或 Drive 檔案。執行後會刪除暫存 Property。
 */
function clearOAuthTokenForRecoveryLineUserHash() {
  var properties = PropertiesService.getScriptProperties();
  try {
    var lineUserHash = assertRecoveryLineUserHash_(
      properties.getProperty('BINDING_RECOVERY_LINE_USER_HASH')
    );
    // 使用與正式流程相同的 LineUser_<hash> OAuth Service 名稱。
    getGoogleOAuthService_(lineUserHash).reset();
    var failedSessionCount = markUnfinishedBindingSessionsFailedForReset_(lineUserHash);
    safeLog_('warn', 'oauth-recovery', 'OAUTH_TOKEN_RESET_FOR_REBIND', 'oauth-recovery');
    return {
      reset: true,
      failedSessionCount: failedSessionCount
    };
  } finally {
    properties.deleteProperty('BINDING_RECOVERY_LINE_USER_HASH');
  }
}

/**
 * 可由「狀態」指令傳入 lineUserHash 呼叫；管理者亦可暫時設定
 * BINDING_RECOVERY_LINE_USER_HASH 後在 Apps Script 編輯器直接執行本函式。
 * 暫存值只包含不可逆雜湊，執行後會立即刪除。
 */
function resumeAuthorizedBinding(lineUserHash) {
  var properties = PropertiesService.getScriptProperties();
  var usesTemporaryProperty = typeof lineUserHash === 'undefined';
  var effectiveLineUserHash = usesTemporaryProperty
    ? properties.getProperty('BINDING_RECOVERY_LINE_USER_HASH')
    : lineUserHash;
  try {
    assertRecoveryLineUserHash_(effectiveLineUserHash);
    var session = findRecoverableBindingSessionByUserHash_(effectiveLineUserHash);
    if (!session) {
      throw createAppError_('BIND_SESSION_NOT_RECOVERABLE', false, '找不到可恢復的綁定工作階段。');
    }
    var result = provisionAuthorizedBinding_(effectiveLineUserHash, session);
    console.log(JSON.stringify({ component: 'binding-recovery', status: 'completed' }));
    return result;
  } finally {
    if (usesTemporaryProperty) {
      properties.deleteProperty('BINDING_RECOVERY_LINE_USER_HASH');
    }
  }
}
