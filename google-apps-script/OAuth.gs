function getGoogleOAuthService_(lineUserHash) {
  if (typeof lineUserHash !== 'string' || !/^[a-f0-9]{64}$/.test(lineUserHash)) {
    throw createAppError_('OAUTH_USER_KEY_INVALID', false, 'OAuth 使用者識別無效。');
  }
  return OAuth2.createService('LineUser_' + lineUserHash)
    .setAuthorizationBaseUrl('https://accounts.google.com/o/oauth2/auth')
    .setTokenUrl('https://oauth2.googleapis.com/token')
    .setClientId(getRequiredProperty_(APP_CONFIG_KEYS_.GOOGLE_OAUTH_CLIENT_ID))
    .setClientSecret(getRequiredProperty_(APP_CONFIG_KEYS_.GOOGLE_OAUTH_CLIENT_SECRET))
    .setCallbackFunction('oauthCallback')
    .setPropertyStore(PropertiesService.getScriptProperties())
    .setCache(CacheService.getScriptCache())
    .setLock(LockService.getScriptLock())
    .setScope('openid email profile https://www.googleapis.com/auth/drive.file')
    .setParam('access_type', 'offline')
    .setParam('prompt', 'consent')
    .setParam('include_granted_scopes', 'true');
}

function getUserAccessToken_(lineUserHash) {
  var service = getGoogleOAuthService_(lineUserHash);
  if (!service.hasAccess()) {
    throw createAppError_('OAUTH_NOT_BOUND', false, '尚未綁定 Google 帳號，請先輸入「綁定 邀請碼」。');
  }
  return service.getAccessToken();
}

function renderBindPage_(bindToken) {
  var tokenPayload = verifyBindToken_(bindToken);
  assertPendingBindingSession_(
    tokenPayload.lineUserHash,
    tokenPayload.nonce,
    tokenPayload.expiresAt
  );
  var service = getGoogleOAuthService_(tokenPayload.lineUserHash);
  var template = HtmlService.createTemplateFromFile('BindPage');
  template.authorizationUrl = service.getAuthorizationUrl({
    lineUserHash: tokenPayload.lineUserHash,
    bindNonce: tokenPayload.nonce,
    expiresAt: String(tokenPayload.expiresAt)
  });
  return template.evaluate()
    .setTitle('綁定 Google Drive')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function oauthCallback(request) {
  var template = HtmlService.createTemplateFromFile('ResultPage');
  template.success = false;
  template.message = 'Google 授權未完成，請回 LINE 重新操作。';
  try {
    var parameters = request && request.parameter ? request.parameter : {};
    var lineUserHash = parameters.lineUserHash || '';
    var bindNonce = parameters.bindNonce || '';
    var expiresAtText = parameters.expiresAt || '';
    if (typeof lineUserHash !== 'string' || !/^[a-f0-9]{64}$/.test(lineUserHash)) {
      throw createAppError_('OAUTH_STATE_INVALID', false, 'OAuth state 驗證失敗。');
    }
    if (typeof bindNonce !== 'string' || !/^[a-f0-9]{16,64}$/.test(bindNonce)) {
      throw createAppError_('OAUTH_STATE_INVALID', false, 'OAuth state 驗證失敗。');
    }
    if (typeof expiresAtText !== 'string' || !/^\d{10,16}$/.test(expiresAtText)) {
      throw createAppError_('OAUTH_STATE_INVALID', false, 'OAuth state 驗證失敗。');
    }
    var expiresAt = Number(expiresAtText);
    validateBindingSessionInput_(lineUserHash, bindNonce, expiresAt, true);
    var session = assertBindingSessionForCallback_(lineUserHash, bindNonce, expiresAt);
    var service = getGoogleOAuthService_(lineUserHash);
    if (session.Status === BINDING_SESSION_STATUS_.PENDING) {
      if (!service.handleCallback(request)) {
        template.message = '你已取消 Google 授權，邀請次數不會扣除。';
        return template.evaluate().setTitle('授權未完成');
      }
      // Token 已由 OAuth2 Library 保存後才進入 AUTHORIZED；後續失敗不得 reset Token。
      session = markBindingSessionAuthorized_(lineUserHash, bindNonce, expiresAt);
    }
    provisionAuthorizedBinding_(lineUserHash, session);
    template.success = true;
    template.message = '綁定完成。之後私訊 Bot 的資料會存入這個 Google 帳號。';
    return template.evaluate().setTitle('綁定完成');
  } catch (error) {
    var appError = isAppError_(error) ? error : createAppError_('OAUTH_CALLBACK_FAILED', true, '綁定失敗，請稍後再試。');
    safeLog_('error', 'oauth', appError.appCode, 'oauth-callback');
    try {
      recordSafeError_('oauth', appError.appCode, appError.safeMessage, 'oauth-callback');
    } catch (loggingError) {
      safeLog_('error', 'oauth-log', 'SAFE_LOG_WRITE_FAILED', 'oauth-callback');
    }
    template.message = session &&
      RECOVERABLE_BINDING_SESSION_STATUSES_.indexOf(session.Status) >= 0
      ? 'Google 授權已保存，但備份空間初始化暫時失敗。管理者可安全恢復，不會再次扣除邀請次數。'
      : appError.safeMessage;
    return template.evaluate().setTitle('綁定失敗');
  }
}

function getGoogleUserProfile_(accessToken) {
  var response = UrlFetchApp.fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    method: 'get',
    headers: { Authorization: 'Bearer ' + accessToken },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw createAppError_('GOOGLE_PROFILE_FAILED', true, '無法取得 Google 帳號資料。');
  }
  var profile = JSON.parse(response.getContentText());
  if (
    typeof profile.sub !== 'string' ||
    profile.sub.length > 200 ||
    typeof profile.email !== 'string' ||
    profile.email.length > 320
  ) {
    throw createAppError_('GOOGLE_PROFILE_INVALID', false, 'Google 帳號資料格式不正確。');
  }
  return { sub: profile.sub, email: profile.email };
}

function unlinkGoogleAccount_(lineUserHash) {
  getGoogleOAuthService_(lineUserHash).reset();
  disableGroupsOwnedBy_(lineUserHash);
  return disableUser_(lineUserHash);
}

/** 管理者可手動執行以取得 Google Cloud 應登錄的精確 callback URI。 */
function logOAuthCallbackUriForAdmin_() {
  var placeholderHash = '0'.repeat(64);
  console.log(getGoogleOAuthService_(placeholderHash).getRedirectUri());
}
