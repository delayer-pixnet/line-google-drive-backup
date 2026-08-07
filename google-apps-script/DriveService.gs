function googleApiFetch_(url, options, accessToken, safeErrorCode) {
  var requestOptions = options || {};
  var headers = Object.assign({}, requestOptions.headers || {}, {
    Authorization: 'Bearer ' + accessToken
  });
  var response = UrlFetchApp.fetch(url, Object.assign({}, requestOptions, {
    headers: headers,
    muteHttpExceptions: true
  }));
  var responseCode = response.getResponseCode();
  if (responseCode < 200 || responseCode >= 300) {
    throw createDriveApiError_(response, safeErrorCode);
  }
  return response;
}

function createDriveCorrelationId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function sanitizeGoogleApiField_(value, fallback) {
  var normalized = String(value || '')
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 80);
  return normalized || fallback;
}

function summarizeGoogleApiMessage_(value) {
  var text = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) {
    return 'Google API 未提供錯誤摘要。';
  }
  // 不回傳可能包含 q、Folder ID、appProperties 或完整查詢的原始訊息。
  if (/appProperties\s+has|in\s+parents|mimeType=|files\.list|[?&]q=/i.test(text)) {
    return 'Google Drive 查詢錯誤。';
  }
  return text
    .replace(/Bearer\s+\S+/gi, '[token]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[id]')
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, '[id]')
    .slice(0, 160);
}

function getGoogleApiErrorDetails_(response) {
  var body = '';
  try {
    body = response.getContentText();
  } catch (error) {
    return {
      reason: 'RESPONSE_BODY_UNAVAILABLE',
      domain: 'googleapis.com',
      messageSummary: 'Google API 回應內容無法讀取。'
    };
  }
  var parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return {
      reason: 'NON_JSON_RESPONSE',
      domain: 'googleapis.com',
      messageSummary: 'Google API 回應不是 JSON。'
    };
  }
  var googleError = parsed && parsed.error ? parsed.error : parsed;
  var firstDetail = googleError && Array.isArray(googleError.errors) && googleError.errors.length > 0
    ? googleError.errors[0]
    : {};
  return {
    reason: sanitizeGoogleApiField_(firstDetail.reason || googleError.reason, 'UNKNOWN_REASON'),
    domain: sanitizeGoogleApiField_(firstDetail.domain || googleError.domain, 'UNKNOWN_DOMAIN'),
    messageSummary: summarizeGoogleApiMessage_(googleError.message || firstDetail.message)
  };
}

function createDriveApiError_(response, safeErrorCode) {
  var httpStatus = response.getResponseCode();
  var details = getGoogleApiErrorDetails_(response);
  var correlationId = createDriveCorrelationId_();
  console.warn(JSON.stringify({
    component: 'drive',
    status: 'http_error',
    errorCode: String(safeErrorCode || 'DRIVE_API_ERROR').slice(0, 60),
    httpStatus: httpStatus,
    googleReason: details.reason,
    googleDomain: details.domain,
    googleMessageSummary: details.messageSummary,
    correlationId: correlationId
  }));
  var appError = createAppError_(
    safeErrorCode,
    httpStatus === 429 || httpStatus >= 500,
    'Google API 暫時無法完成操作，請稍後重試。'
  );
  appError.correlationId = correlationId;
  appError.httpStatus = httpStatus;
  appError.googleReason = details.reason;
  appError.googleDomain = details.domain;
  appError.googleMessageSummary = details.messageSummary;
  return appError;
}

function parseJsonResponse_(response, errorCode) {
  try {
    return JSON.parse(response.getContentText());
  } catch (error) {
    throw createAppError_(errorCode, true, 'Google API 回應格式不正確。');
  }
}

function createDriveFolder_(accessToken, folderName, parentId, appProperties) {
  var metadata = {
    name: sanitizeFileName_(folderName, '未命名資料夾'),
    mimeType: 'application/vnd.google-apps.folder'
  };
  if (parentId) {
    metadata.parents = [parentId];
  }
  if (appProperties) {
    metadata.appProperties = appProperties;
  }
  var response = googleApiFetch_(
    'https://www.googleapis.com/drive/v3/files?fields=id,name',
    {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      payload: JSON.stringify(metadata)
    },
    accessToken,
    'DRIVE_FOLDER_CREATE_FAILED'
  );
  var result = parseJsonResponse_(response, 'DRIVE_FOLDER_RESPONSE_INVALID');
  if (typeof result.id !== 'string') {
    throw createAppError_('DRIVE_FOLDER_ID_MISSING', true, 'Google Drive 未回傳資料夾識別碼。');
  }
  return result.id;
}

function buildDriveAppPropertiesQuery_(propertyName, propertyValue, parentId, mimeType) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(propertyName) ||
      typeof propertyValue !== 'string' || propertyValue.length === 0 || propertyValue.length > 200) {
    throw createAppError_('DRIVE_APP_PROPERTY_INVALID', false, 'Drive appProperties 設定無效。');
  }
  var queryParts = [
    "appProperties has { key='" + escapeDriveQuery_(propertyName) +
      "' and value='" + escapeDriveQuery_(propertyValue) + "' }",
    'trashed=false'
  ];
  if (parentId) {
    queryParts.push("'" + escapeDriveQuery_(parentId) + "' in parents");
  }
  if (mimeType) {
    queryParts.push("mimeType='" + escapeDriveQuery_(mimeType) + "'");
  }
  return queryParts.join(' and ');
}

function buildDriveFilesListUrl_(query) {
  var fields = 'files(id,name,mimeType,appProperties,webViewLink)';
  return 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(query) +
    '&spaces=drive&fields=' + encodeURIComponent(fields) + '&pageSize=2';
}

function getDriveItemFromListResult_(result) {
  if (!result || !Array.isArray(result.files) || result.files.length === 0) {
    return null;
  }
  var file = result.files[0];
  if (!file || typeof file.id !== 'string' || !/^[A-Za-z0-9_-]{5,200}$/.test(file.id)) {
    throw createAppError_('DRIVE_IDEMPOTENCY_FILE_INVALID', true, 'Google Drive 回傳的冪等檔案資料不正確。');
  }
  return {
    id: file.id,
    webViewLink: typeof file.webViewLink === 'string'
      ? file.webViewLink
      : 'https://drive.google.com/open?id=' + encodeURIComponent(String(file.id))
  };
}

function findDriveItemByAppProperty_(accessToken, propertyName, propertyValue, parentId, mimeType) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(propertyName) ||
      typeof propertyValue !== 'string' || !/^[a-f0-9]{64}$/.test(propertyValue)) {
    throw createAppError_('DRIVE_APP_PROPERTY_INVALID', false, 'Drive 冪等識別資料不正確。');
  }
  var query = buildDriveAppPropertiesQuery_(propertyName, propertyValue, parentId, mimeType);
  var url = buildDriveFilesListUrl_(query);
  var response = googleApiFetch_(url, { method: 'get' }, accessToken, 'DRIVE_IDEMPOTENCY_SEARCH_FAILED');
  var result = parseJsonResponse_(response, 'DRIVE_IDEMPOTENCY_SEARCH_INVALID');
  return getDriveItemFromListResult_(result);
}

function escapeDriveQuery_(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function findDriveFolder_(accessToken, folderName, parentId) {
  var query = [
    "mimeType='application/vnd.google-apps.folder'",
    "name='" + escapeDriveQuery_(folderName) + "'",
    "'" + escapeDriveQuery_(parentId) + "' in parents",
    'trashed=false'
  ].join(' and ');
  var url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(query) +
    '&spaces=drive&fields=files(id,name)&pageSize=10';
  var response = googleApiFetch_(url, { method: 'get' }, accessToken, 'DRIVE_FOLDER_SEARCH_FAILED');
  var result = parseJsonResponse_(response, 'DRIVE_FOLDER_SEARCH_INVALID');
  return result.files && result.files.length > 0 ? result.files[0].id : null;
}

function ensureDriveFolder_(accessToken, folderName, parentId) {
  return findDriveFolder_(accessToken, folderName, parentId) ||
    createDriveFolder_(accessToken, folderName, parentId);
}

function ensureDriveFolderByResourceKey_(accessToken, folderName, parentId, resourceKey) {
  var existing = findDriveItemByAppProperty_(
    accessToken,
    'lineBackupResourceKey',
    resourceKey,
    parentId,
    'application/vnd.google-apps.folder'
  );
  return existing
    ? existing.id
    : createDriveFolder_(accessToken, folderName, parentId, {
        lineBackupResourceKey: resourceKey
      });
}

function createUserResourceKey_(lineUserHash, resourceType) {
  if (typeof lineUserHash !== 'string' || !/^[a-f0-9]{64}$/.test(lineUserHash)) {
    throw createAppError_('RESOURCE_USER_HASH_INVALID', false, '使用者資源識別無效。');
  }
  return hashIdentifier_('USER_RESOURCE:' + lineUserHash + ':' + resourceType);
}

function hasCompleteUserResources_(user) {
  return user && ['RootFolderId', 'PersonalFolderId', 'GroupFolderId', 'SheetId'].every(function (name) {
    return typeof user[name] === 'string' && /^[A-Za-z0-9_-]{5,200}$/.test(user[name]);
  });
}

function ensureUserResources_(accessToken, lineUserHash, existingUser) {
  if (hasCompleteUserResources_(existingUser)) {
    return {
      rootFolderId: String(existingUser.RootFolderId),
      personalFolderId: String(existingUser.PersonalFolderId),
      groupFolderId: String(existingUser.GroupFolderId),
      sheetId: String(existingUser.SheetId)
    };
  }
  var rootFolderId = ensureDriveFolderByResourceKey_(
    accessToken,
    'LINE 自動備份',
    null,
    createUserResourceKey_(lineUserHash, 'ROOT')
  );
  var personalFolderId = ensureDriveFolderByResourceKey_(
    accessToken,
    '個人備份',
    rootFolderId,
    createUserResourceKey_(lineUserHash, 'PERSONAL')
  );
  var groupFolderId = ensureDriveFolderByResourceKey_(
    accessToken,
    '群組備份',
    rootFolderId,
    createUserResourceKey_(lineUserHash, 'GROUP')
  );
  var sheetId = ensureBackupSpreadsheet_(
    accessToken,
    rootFolderId,
    createUserResourceKey_(lineUserHash, 'SHEET')
  );
  return {
    rootFolderId: rootFolderId,
    personalFolderId: personalFolderId,
    groupFolderId: groupFolderId,
    sheetId: sheetId
  };
}

function createDriveEventKey_(webhookEventId) {
  if (typeof webhookEventId !== 'string' || webhookEventId.length === 0 || webhookEventId.length > 128) {
    throw createAppError_('DRIVE_EVENT_ID_INVALID', false, '事件冪等識別資料不正確。');
  }
  return hashIdentifier_('DRIVE_EVENT:' + webhookEventId);
}

function findUploadedDriveFileByEventKey_(accessToken, folderId, eventKey) {
  return findDriveItemByAppProperty_(
    accessToken,
    'lineBackupEventKey',
    eventKey,
    folderId,
    null
  );
}

function ensureDatedTypeFolder_(accessToken, baseFolderId, messageTimestamp, messageType) {
  var date = new Date(messageTimestamp);
  var year = Utilities.formatDate(date, 'Asia/Taipei', 'yyyy');
  var month = Utilities.formatDate(date, 'Asia/Taipei', 'MM');
  var typeNames = {
    image: '圖片',
    video: '影片',
    audio: '音訊',
    file: '檔案'
  };
  var yearFolderId = ensureDriveFolder_(accessToken, year, baseFolderId);
  var monthFolderId = ensureDriveFolder_(accessToken, month, yearFolderId);
  return ensureDriveFolder_(accessToken, typeNames[messageType] || '其他', monthFolderId);
}

function createGroupBackupFolder_(accessToken, groupRootFolderId, groupName, groupIdHash) {
  var safeName = sanitizeFileName_(groupName, '未命名群組');
  return ensureDriveFolder_(accessToken, safeName + '_' + groupIdHash.slice(0, 10), groupRootFolderId);
}

function uploadBlobToDrive_(accessToken, folderId, fileName, contentType, blob, eventKey) {
  if (typeof eventKey !== 'string' || !/^[a-f0-9]{64}$/.test(eventKey)) {
    throw createAppError_('DRIVE_EVENT_KEY_INVALID', false, '事件冪等識別資料不正確。');
  }
  var byteLength = blob.getBytes().length;
  var initiateResponse = googleApiFetch_(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink',
    {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: {
        'X-Upload-Content-Type': contentType,
        'X-Upload-Content-Length': String(byteLength)
      },
      payload: JSON.stringify({
        name: fileName,
        parents: [folderId],
        appProperties: { lineBackupEventKey: eventKey }
      })
    },
    accessToken,
    'DRIVE_UPLOAD_START_FAILED'
  );
  var responseHeaders = initiateResponse.getHeaders();
  var uploadUrl = responseHeaders.Location || responseHeaders.location;
  if (typeof uploadUrl !== 'string' || uploadUrl.indexOf('https://') !== 0) {
    throw createAppError_('DRIVE_UPLOAD_URL_MISSING', true, 'Google Drive 未提供上傳位置。');
  }
  var uploadResponse = googleApiFetch_(
    uploadUrl,
    { method: 'put', contentType: contentType, payload: blob },
    accessToken,
    'DRIVE_UPLOAD_FAILED'
  );
  var result = parseJsonResponse_(uploadResponse, 'DRIVE_UPLOAD_RESPONSE_INVALID');
  if (typeof result.id !== 'string') {
    throw createAppError_('DRIVE_FILE_ID_MISSING', true, 'Google Drive 未回傳檔案識別碼。');
  }
  return {
    id: result.id,
    webViewLink: typeof result.webViewLink === 'string'
      ? result.webViewLink
      : 'https://drive.google.com/open?id=' + encodeURIComponent(result.id)
  };
}

function deleteDriveFile_(accessToken, driveFileId) {
  if (typeof driveFileId !== 'string' || !/^[A-Za-z0-9_-]{5,200}$/.test(driveFileId)) {
    return false;
  }
  googleApiFetch_(
    'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(driveFileId),
    { method: 'delete' },
    accessToken,
    'DRIVE_DELETE_FAILED'
  );
  return true;
}
