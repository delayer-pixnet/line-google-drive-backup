var OAUTH_REAUTH_GROUP_REMINDER_TTL_SECONDS_ = 30 * 60;
var OAUTH_REAUTH_STATUS_ = 'OAUTH_REAUTH_REQUIRED';
var OAUTH_REAUTH_PENDING_STATUS_ = 'RETRY_REQUESTED_PENDING_REAUTH';

function isOAuthReauthFailure_(error) {
  if (!isAppError_(error)) {
    return false;
  }
  if ([
    'OAUTH_NOT_BOUND',
    'OAUTH_TOKEN_MISSING',
    'OAUTH_TOKEN_EMPTY',
    'OAUTH_TOKEN_READ_FAILED'
  ].indexOf(error.appCode) >= 0) {
    return true;
  }
  return error.httpStatus === 401 ||
    (error.httpStatus === 403 && error.googleReason === 'insufficientPermissions');
}

function getOAuthReauthErrorCode_(job) {
  return job && job.groupIdHash
    ? 'GROUP_OWNER_OAUTH_REAUTH_REQUIRED'
    : 'OAUTH_REAUTH_REQUIRED';
}

function getOAuthReauthSafeMessage_(job) {
  return job && job.groupIdHash
    ? '群組備份擁有者的 Google 授權已失效，暫時無法備份。'
    : 'Google 授權已失效，這次備份已暫存為待補備份項目。';
}

function getOAuthReauthReply_(job, errorCode) {
  if (!job || !job.groupIdHash) {
    return 'Google 授權已失效，請輸入「重新授權」重新連結 Google 帳號。這次備份已暫存為待補備份項目，重新授權後可輸入「補備份 今日」嘗試補回。';
  }
  var cacheKey = 'OAUTH_REAUTH_REMINDER:' + hashIdentifier_(
    'GROUP:' + job.groupIdHash + ':' + String(errorCode || 'GROUP_OWNER_OAUTH_REAUTH_REQUIRED')
  ).slice(0, 32);
  try {
    var cache = CacheService.getScriptCache();
    if (cache.get(cacheKey)) {
      return null;
    }
    cache.put(cacheKey, '1', OAUTH_REAUTH_GROUP_REMINDER_TTL_SECONDS_);
  } catch (error) {
    // CacheService 暫時不可用時仍提醒一次，不能讓授權失效變成靜默失敗。
  }
  return '群組備份擁有者的 Google 授權已失效，暫時無法備份。請群組備份擁有者私訊 Bot 輸入「重新授權」。';
}

function createOAuthReauthResult_(job, context, error) {
  var errorCode = getOAuthReauthErrorCode_(job);
  var safeMessage = getOAuthReauthSafeMessage_(job);
  var replyMessage = getOAuthReauthReply_(job, errorCode);
  var appError = isAppError_(error) ? error : null;
  var result = {
    jobStatus: OAUTH_REAUTH_STATUS_,
    errorCode: errorCode,
    safeMessage: safeMessage
  };
  if (replyMessage) {
    result.replyMessage = replyMessage;
  }
  console.warn(JSON.stringify({
    component: 'oauth-token',
    status: 'reauth_required',
    errorCode: errorCode,
    correlationId: appError && appError.correlationId ? appError.correlationId : 'oauth-recovery',
    userHashPrefix: job && job.lineUserHash ? String(job.lineUserHash).slice(0, 8) : '',
    groupHashPrefix: job && job.groupIdHash ? String(job.groupIdHash).slice(0, 8) : '',
    ownerHashPrefix: context && context.ownerHash ? String(context.ownerHash).slice(0, 8) : ''
  }));
  return result;
}

function isOAuthReauthJobStatus_(status) {
  return [OAUTH_REAUTH_STATUS_, OAUTH_REAUTH_PENDING_STATUS_].indexOf(String(status || '')) >= 0;
}

function countPendingOAuthReauthJobs_(lineUserHash) {
  if (typeof lineUserHash !== 'string' || !/^[a-f0-9]{64}$/.test(lineUserHash)) {
    return 0;
  }
  try {
    return getSheetRecords_('Jobs').filter(function (job) {
      return (job.LineUserHash === lineUserHash || job.OwnerLineUserHash === lineUserHash) &&
        isOAuthReauthJobStatus_(job.Status);
    }).length;
  } catch (error) {
    return 0;
  }
}
