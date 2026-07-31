function provisionAuthorizedBinding_(lineUserHash, session) {
  var provisioningSession = beginBindingSessionProvisioning_(
    lineUserHash,
    session.SessionNonceHash
  );
  try {
    var service = getGoogleOAuthService_(lineUserHash);
    if (!service.hasAccess()) {
      throw createAppError_('OAUTH_NOT_BOUND', false, 'Google 授權已失效，請重新綁定。');
    }
    var accessToken = service.getAccessToken();
    var profile = getGoogleUserProfile_(accessToken);
    var existing = findUserByHash_(lineUserHash);
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

    completeBindingSession_(lineUserHash, provisioningSession.SessionNonceHash, {
      lineUserHash: lineUserHash,
      googleSubjectId: profile.sub,
      googleEmail: profile.email,
      rootFolderId: resources.rootFolderId,
      personalFolderId: resources.personalFolderId,
      groupFolderId: resources.groupFolderId,
      sheetId: resources.sheetId
    });
    return { completed: true };
  } catch (error) {
    var appError = isAppError_(error)
      ? error
      : createAppError_('BIND_PROVISIONING_FAILED', true, 'Google 備份空間初始化失敗，請稍後重試。');
    markBindingSessionFailed_(lineUserHash, provisioningSession.SessionNonceHash, appError.appCode);
    throw appError;
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
    if (typeof effectiveLineUserHash !== 'string' || !/^[a-f0-9]{64}$/.test(effectiveLineUserHash)) {
      throw createAppError_(
        'BIND_RECOVERY_USER_INVALID',
        false,
        '請提供有效的 LINE 使用者雜湊以恢復綁定。'
      );
    }
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
