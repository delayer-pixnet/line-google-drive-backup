var GOOGLE_USER_OAUTH_SCOPES_ = Object.freeze([
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.file'
]);

function getGoogleUserOAuthScopeString_() {
  return GOOGLE_USER_OAUTH_SCOPES_.join(' ');
}

function getGoogleOAuthAuthorizationParams_(extraParams) {
  var params = Object.assign({}, extraParams || {});
  params.access_type = 'offline';
  params.prompt = 'consent';
  params.include_granted_scopes = 'true';
  return params;
}

function getOAuthServiceName_(lineUserHash) {
  return 'LineUser_' + lineUserHash;
}

function getOAuthServiceDiagnosticKey_(lineUserHash) {
  try {
    return hashIdentifier_('OAUTH_SERVICE:' + getOAuthServiceName_(lineUserHash)).slice(0, 16);
  } catch (error) {
    return 'unavailable';
  }
}

function createOAuthTokenCorrelationId_() {
  return 'oauth-token-' + Utilities.getUuid().replace(/-/g, '').slice(0, 20);
}

function logOAuthTokenState_(lineUserHash, hasOAuthToken, errorCode, correlationId) {
  var user = null;
  try {
    user = findUserByHash_(lineUserHash);
  } catch (error) {
    user = null;
  }
  var approvalStatus = user ? getUserApprovalStatus_(user) : null;
  console.info(JSON.stringify({
    component: 'oauth-token',
    userHashPrefix: typeof lineUserHash === 'string' && /^[a-f0-9]{64}$/.test(lineUserHash)
      ? lineUserHash.slice(0, 8)
      : '',
    hasUser: Boolean(user),
    enabled: Boolean(user && isEnabledUserValue_(user.Enabled)),
    approvalStatus: approvalStatus === USER_APPROVAL_STATUS_.APPROVED
      ? USER_APPROVAL_STATUS_.APPROVED
      : approvalStatus === USER_APPROVAL_STATUS_.PENDING ? 'PENDING' : '',
    hasOAuthToken: hasOAuthToken === true,
    oauthServiceNameHash: getOAuthServiceDiagnosticKey_(lineUserHash),
    correlationId: String(correlationId || '').slice(0, 100),
    errorCode: String(errorCode || 'TOKEN_STATE').slice(0, 60)
  }));
}

function getGoogleOAuthService_(lineUserHash) {
  if (typeof lineUserHash !== 'string' || !/^[a-f0-9]{64}$/.test(lineUserHash)) {
    throw createAppError_('OAUTH_USER_KEY_INVALID', false, 'OAuth 使用者識別無效。');
  }
  return OAuth2.createService(getOAuthServiceName_(lineUserHash))
    .setAuthorizationBaseUrl('https://accounts.google.com/o/oauth2/auth')
    .setTokenUrl('https://oauth2.googleapis.com/token')
    .setClientId(getRequiredProperty_(APP_CONFIG_KEYS_.GOOGLE_OAUTH_CLIENT_ID))
    .setClientSecret(getRequiredProperty_(APP_CONFIG_KEYS_.GOOGLE_OAUTH_CLIENT_SECRET))
    .setCallbackFunction('oauthCallback')
    .setPropertyStore(PropertiesService.getScriptProperties())
    .setCache(CacheService.getScriptCache())
    .setLock(LockService.getScriptLock())
    .setScope(getGoogleUserOAuthScopeString_())
    .setParam('access_type', 'offline')
    .setParam('prompt', 'consent')
    .setParam('include_granted_scopes', 'true');
}

function getUserAccessToken_(lineUserHash) {
  var correlationId = createOAuthTokenCorrelationId_();
  var service;
  try {
    service = getGoogleOAuthService_(lineUserHash);
  } catch (error) {
    logOAuthTokenState_(lineUserHash, false, 'OAUTH_SERVICE_UNAVAILABLE', correlationId);
    throw error;
  }
  try {
    if (!service.hasAccess()) {
      logOAuthTokenState_(lineUserHash, false, 'OAUTH_TOKEN_MISSING', correlationId);
      throw createAppError_('OAUTH_NOT_BOUND', false, '尚未完成 Google 綁定。');
    }
    var accessToken = service.getAccessToken();
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      logOAuthTokenState_(lineUserHash, false, 'OAUTH_TOKEN_EMPTY', correlationId);
      throw createAppError_('OAUTH_TOKEN_READ_FAILED', false, 'Google 授權已失效，請重新授權。');
    }
    logOAuthTokenState_(lineUserHash, true, 'OAUTH_TOKEN_AVAILABLE', correlationId);
    return accessToken;
  } catch (error) {
    if (isAppError_(error)) {
      throw error;
    }
    logOAuthTokenState_(lineUserHash, false, 'OAUTH_TOKEN_READ_FAILED', correlationId);
    throw createAppError_('OAUTH_TOKEN_READ_FAILED', true, '暫時無法讀取 Google 授權，請稍後再試。');
  }
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
  template.authorizationUrl = service.getAuthorizationUrl(getGoogleOAuthAuthorizationParams_({
    lineUserHash: tokenPayload.lineUserHash,
    bindNonce: tokenPayload.nonce,
    expiresAt: String(tokenPayload.expiresAt)
  }));
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
        template.message = '你已取消 Google 授權，邀請次數不會扣除（若使用邀請碼）。';
        return template.evaluate().setTitle('授權未完成');
      }
      logOAuthTokenState_(lineUserHash, service.hasAccess(), 'OAUTH_TOKEN_SAVED', 'oauth-callback');
      // Token 已由 OAuth2 Library 保存後才進入 AUTHORIZED；後續失敗不得 reset Token。
      session = markBindingSessionAuthorized_(lineUserHash, bindNonce, expiresAt);
    }
    var provisionResult = provisionAuthorizedBinding_(lineUserHash, session);
    template.success = true;
    template.message = !session.InviteCodeHash &&
      !isAdminApprovalRequired_() &&
      provisionResult.approvalStatus === USER_APPROVAL_STATUS_.APPROVED
      ? 'Google 授權完成，已啟用備份。'
      : provisionResult.approvalStatus === USER_APPROVAL_STATUS_.PENDING
      ? 'Google 授權完成，等待管理者審核。審核通過後才會開始備份。'
      : '綁定完成。之後私訊 Bot 的資料會存入這個 Google 帳號。';
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
