var DRIVE_QUOTA_CACHE_TTL_SECONDS_ = 600;
var DRIVE_QUOTA_CACHE_PREFIX_ = 'LINE_DRIVE_QUOTA_V1:';
var DRIVE_QUOTA_MAX_SCAN_FILES_ = 10000;

function getPersonalDriveQuotaReply_(lineUserHash) {
  var state = getUserBindingState_(lineUserHash);
  var correlationId = createDriveCorrelationId_();
  try {
    var accessToken = getDriveQuotaAccessToken_(lineUserHash, state, correlationId);
    var result = getOrComputeDriveQuotaResult_(lineUserHash, function () {
      var quota = getDriveQuota_(accessToken);
      var lineBackupUsage = estimateLineBackupUsage_(accessToken, state.user);
      return {
        limit: quota.limit,
        usage: quota.usage,
        usageInDrive: quota.usageInDrive,
        usageInDriveTrash: quota.usageInDriveTrash,
        lineBackupUsage: lineBackupUsage,
        updatedAt: formatDriveQuotaTime_(new Date())
      };
    });
    return formatPersonalDriveQuotaReply_(result);
  } catch (error) {
    return handleDriveQuotaError_(error, state, correlationId);
  }
}

function getOwnedGroupDriveQuotaReply_(lineUserHash) {
  var state = getUserBindingState_(lineUserHash);
  var correlationId = createDriveCorrelationId_();
  var groups = getSheetRecords_('Groups').filter(function (group) {
    return group.OwnerLineUserHash === lineUserHash && group.Enabled === true &&
      typeof group.FolderId === 'string' && group.FolderId.length > 0;
  });
  if (groups.length === 0) {
    return '目前沒有由你擁有的群組備份。';
  }
  try {
    var accessToken = getDriveQuotaAccessToken_(lineUserHash, state, correlationId);
    var result = getOrComputeDriveQuotaResult_(lineUserHash + '_groups', function () {
      var entries = groups.map(function (group) {
        return {
          groupName: sanitizeDisplayNameForSheet_(group.GroupName, '群組備份'),
          usage: estimateDriveUsageForFolders_(accessToken, [group.FolderId])
        };
      });
      return {
        entries: entries,
        total: entries.reduce(function (sum, entry) { return sum + entry.usage; }, 0),
        updatedAt: formatDriveQuotaTime_(new Date())
      };
    });
    return formatOwnedGroupDriveQuotaReply_(result);
  } catch (error) {
    return handleDriveQuotaError_(error, state, correlationId);
  }
}

function getDriveQuotaAccessToken_(lineUserHash, state, correlationId) {
  var hasApprovedAccess = Boolean(
    state && state.hasUser && state.enabled &&
    state.approvalStatus === USER_APPROVAL_STATUS_.APPROVED
  );
  if (!hasApprovedAccess) {
    logDriveQuotaUserState_(state, correlationId, false, 'USER_NOT_ENABLED');
    throw createAppError_('DRIVE_QUOTA_USER_NOT_ENABLED', false, '請先完成 Google 帳號綁定後再查詢容量。');
  }
  try {
    var accessToken = getUserAccessToken_(lineUserHash);
    logDriveQuotaUserState_(state, correlationId, true, 'USER_AUTHORIZED');
    return accessToken;
  } catch (error) {
    if (isAppError_(error) && error.appCode === 'OAUTH_NOT_BOUND') {
      var tokenError = createAppError_(
        'OAUTH_TOKEN_MISSING',
        false,
        'Google 授權已失效，請重新輸入「綁定」完成授權。'
      );
      tokenError.correlationId = correlationId;
      logDriveQuotaUserState_(state, correlationId, false, tokenError.appCode);
      throw tokenError;
    }
    if (isAppError_(error) && !error.correlationId) {
      error.correlationId = correlationId;
    }
    throw error;
  }
}

function logDriveQuotaUserState_(state, correlationId, hasOAuthToken, errorCode) {
  var lineUserHash = state && state.user ? state.user.LineUserHash : '';
  var userHashPrefix = typeof lineUserHash === 'string' && /^[a-f0-9]{64}$/.test(lineUserHash)
    ? lineUserHash.slice(0, 8)
    : '';
  var approvalStatus = state && state.approvalStatus;
  approvalStatus = approvalStatus === USER_APPROVAL_STATUS_.APPROVED
    ? USER_APPROVAL_STATUS_.APPROVED
    : approvalStatus === USER_APPROVAL_STATUS_.PENDING
      ? 'PENDING'
      : '';
  console.info(JSON.stringify({
    component: 'drive-quota',
    errorCode: String(errorCode || 'USER_STATE').slice(0, 60),
    correlationId: String(correlationId || '').slice(0, 100),
    userHashPrefix: userHashPrefix,
    hasUser: Boolean(state && state.hasUser),
    enabled: Boolean(state && state.enabled),
    approvalStatus: approvalStatus,
    hasOAuthToken: hasOAuthToken === true
  }));
}

function getDriveQuota_(accessToken) {
  var fields = encodeURIComponent('storageQuota,user');
  var response = googleApiFetch_(
    'https://www.googleapis.com/drive/v3/about?fields=' + fields,
    { method: 'get' },
    accessToken,
    'DRIVE_QUOTA_READ_FAILED'
  );
  var result = parseJsonResponse_(response, 'DRIVE_QUOTA_RESPONSE_INVALID');
  var storageQuota = result && result.storageQuota && typeof result.storageQuota === 'object'
    ? result.storageQuota
    : {};
  return {
    limit: parseDriveQuotaNumber_(storageQuota.limit),
    usage: parseDriveQuotaNumber_(storageQuota.usage),
    usageInDrive: parseDriveQuotaNumber_(storageQuota.usageInDrive),
    usageInDriveTrash: parseDriveQuotaNumber_(storageQuota.usageInDriveTrash)
  };
}

function estimateLineBackupUsage_(accessToken, user) {
  return estimateDriveUsageForFolders_(accessToken, [
    user.RootFolderId,
    user.PersonalFolderId,
    user.GroupFolderId,
    user.SheetId
  ]);
}

function estimateDriveUsageForFolders_(accessToken, folderIds) {
  var pendingFolders = (Array.isArray(folderIds) ? folderIds : []).filter(function (folderId) {
    return typeof folderId === 'string' && /^[A-Za-z0-9_-]{5,200}$/.test(folderId);
  });
  var visitedFolders = {};
  var countedFiles = {};
  var totalBytes = 0;
  var scannedFiles = 0;
  while (pendingFolders.length > 0) {
    var folderId = pendingFolders.shift();
    if (visitedFolders[folderId]) {
      continue;
    }
    visitedFolders[folderId] = true;
    var pageToken = '';
    do {
      var response = googleApiFetch_(
        buildDriveChildrenListUrl_(folderId, pageToken),
        { method: 'get' },
        accessToken,
        'DRIVE_QUOTA_SCAN_FAILED'
      );
      var result = parseJsonResponse_(response, 'DRIVE_QUOTA_SCAN_RESPONSE_INVALID');
      var files = Array.isArray(result.files) ? result.files : [];
      files.forEach(function (file) {
        if (!file || typeof file.id !== 'string' || countedFiles[file.id]) {
          return;
        }
        countedFiles[file.id] = true;
        scannedFiles += 1;
        if (scannedFiles > DRIVE_QUOTA_MAX_SCAN_FILES_) {
          throw createAppError_('DRIVE_QUOTA_SCAN_LIMIT', true, '備份資料夾檔案數量過多，請稍後再試。');
        }
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          pendingFolders.push(file.id);
          return;
        }
        totalBytes += sumDriveFileSizes_([file]);
      });
      pageToken = typeof result.nextPageToken === 'string' ? result.nextPageToken : '';
    } while (pageToken);
  }
  return totalBytes;
}

function sumDriveFileSizes_(files) {
  return (Array.isArray(files) ? files : []).reduce(function (sum, file) {
    if (!file || file.mimeType === 'application/vnd.google-apps.folder') {
      return sum;
    }
    var size = parseDriveQuotaNumber_(file.size);
    return size === null ? sum : sum + size;
  }, 0);
}

function buildDriveChildrenListUrl_(parentId, pageToken) {
  var query = "'" + escapeDriveQuery_(parentId) + "' in parents and trashed=false";
  var fields = 'nextPageToken,files(id,mimeType,size)';
  var url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(query) +
    '&spaces=drive&fields=' + encodeURIComponent(fields) + '&pageSize=1000';
  return pageToken ? url + '&pageToken=' + encodeURIComponent(pageToken) : url;
}

function parseDriveQuotaNumber_(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  var text = String(value);
  if (!/^\d+$/.test(text)) {
    return null;
  }
  var parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function formatDriveQuotaBytes_(bytes) {
  var value = parseDriveQuotaNumber_(bytes);
  if (value === null) {
    return '未提供';
  }
  var units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var unitIndex = 0;
  var scaled = value;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  var formatted = unitIndex === 0 ? String(Math.round(scaled)) : scaled.toFixed(1);
  formatted = formatted.replace(/\.0$/, '');
  return formatted + ' ' + units[unitIndex];
}

function formatDriveQuotaPercentage_(usage, limit) {
  if (usage === null || limit === null || limit <= 0) {
    return null;
  }
  return (Math.min(100, Math.max(0, usage / limit * 100))).toFixed(1) + '%';
}

function formatDriveQuotaTime_(date) {
  return Utilities.formatDate(date, 'Asia/Taipei', 'yyyy/MM/dd HH:mm');
}

function formatPersonalDriveQuotaReply_(result) {
  var lines = [
    '📦 Google Drive 容量資訊',
    '總容量：' + (result.limit === null ? '未提供或無限制' : formatDriveQuotaBytes_(result.limit)),
    '已使用：' + formatDriveQuotaBytes_(result.usage),
    'Drive 檔案使用：' + formatDriveQuotaBytes_(result.usageInDrive),
    '垃圾桶使用：' + formatDriveQuotaBytes_(result.usageInDriveTrash),
    'LINE 備份資料夾：約 ' + formatDriveQuotaBytes_(result.lineBackupUsage),
    '更新時間：' + result.updatedAt
  ];
  if (result.limit !== null) {
    lines.splice(3, 0, '剩餘容量：' + formatDriveQuotaBytes_(Math.max(0, result.limit - (result.usage || 0))));
    lines.splice(4, 0, '使用率：' + (formatDriveQuotaPercentage_(result.usage || 0, result.limit) || '未提供'));
  }
  return lines.join('\n');
}

function formatOwnedGroupDriveQuotaReply_(result) {
  var lines = ['📦 群組備份容量'];
  result.entries.slice(0, 20).forEach(function (entry) {
    lines.push(entry.groupName + '：約 ' + formatDriveQuotaBytes_(entry.usage));
  });
  if (result.entries.length > 20) {
    lines.push('其餘群組：已省略');
  }
  lines.push('合計：約 ' + formatDriveQuotaBytes_(result.total));
  lines.push('更新時間：' + result.updatedAt);
  return lines.join('\n');
}

function getDriveQuotaCacheKey_(lineUserHash) {
  if (typeof lineUserHash !== 'string' || !/^[a-f0-9]{64}(?:_groups)?$/.test(lineUserHash)) {
    throw createAppError_('DRIVE_QUOTA_CACHE_KEY_INVALID', false, '容量快取識別無效。');
  }
  return DRIVE_QUOTA_CACHE_PREFIX_ + lineUserHash;
}

function getOrComputeDriveQuotaResult_(lineUserHash, computeFunction) {
  var cache = CacheService.getScriptCache();
  var cacheKey = getDriveQuotaCacheKey_(lineUserHash);
  var cached = cache.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (error) {
      cache.remove(cacheKey);
    }
  }
  var result = computeFunction();
  cache.put(cacheKey, JSON.stringify(result), DRIVE_QUOTA_CACHE_TTL_SECONDS_);
  return result;
}

function handleDriveQuotaError_(error, state, correlationId) {
  var appError = isAppError_(error)
    ? error
    : createAppError_('DRIVE_QUOTA_UNAVAILABLE', true, '暫時無法取得容量資訊，請稍後再試。');
  correlationId = appError.correlationId || correlationId || createDriveCorrelationId_();
  logDriveQuotaUserState_(state, correlationId, false, appError.appCode);
  safeLog_('warn', 'drive-quota', appError.appCode, correlationId);
  try {
    recordSafeError_('drive-quota', appError.appCode, appError.safeMessage, correlationId);
  } catch (loggingError) {
    safeLog_('warn', 'drive-quota-log', 'SAFE_LOG_WRITE_FAILED', correlationId);
  }
  return getDriveQuotaUserMessage_(appError);
}

function getDriveQuotaUserMessage_(appError) {
  if (appError && ['OAUTH_NOT_BOUND', 'DRIVE_QUOTA_USER_NOT_ENABLED'].indexOf(appError.appCode) >= 0) {
    return '請先完成 Google 帳號綁定後再查詢容量。';
  }
  if (appError && ['OAUTH_TOKEN_MISSING', 'OAUTH_TOKEN_READ_FAILED'].indexOf(appError.appCode) >= 0) {
    return 'Google 授權已失效，請重新輸入「綁定」完成授權。';
  }
  if (appError && appError.httpStatus === 403 && appError.googleReason === 'insufficientPermissions') {
    return '目前 Google Drive 授權不足，請重新輸入「綁定」完成授權。';
  }
  return '暫時無法取得容量資訊，請稍後再試。';
}
