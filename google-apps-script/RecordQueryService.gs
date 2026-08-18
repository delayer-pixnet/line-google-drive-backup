var RECORD_QUERY_TOKEN_TTL_MILLISECONDS_ = 10 * 60 * 1000;
var RECORD_QUERY_PROPERTY_PREFIX_ = 'RECORD_QUERY_';
var RECORD_QUERY_SHORT_CODE_LENGTH_ = 10;
var RECORD_QUERY_TYPES_ = Object.freeze(['all', 'text', 'image', 'video', 'audio', 'file', 'note']);

function encodeRecordQueryPayload_(payload) {
  return Utilities.base64EncodeWebSafe(
    Utilities.newBlob(JSON.stringify(payload)).getBytes()
  ).replace(/=+$/g, '');
}

function getRecordQueryPropertyKey_(nonce) {
  return RECORD_QUERY_PROPERTY_PREFIX_ + hashIdentifier_('RECORD_QUERY_NONCE:' + nonce);
}

function hashRecordQueryToken_(token) {
  return hmacHex_(
    getRequiredProperty_(APP_CONFIG_KEYS_.IDENTIFIER_HASH_SECRET),
    'RECORD_QUERY_TOKEN:' + String(token)
  );
}

function isRecordQueryShortCode_(shortCode) {
  return typeof shortCode === 'string' && /^[A-Za-z0-9_-]{8,12}$/.test(shortCode);
}

function createRecordQueryShortCode_() {
  var shortCode = Utilities.getUuid().replace(/-/g, '').slice(0, RECORD_QUERY_SHORT_CODE_LENGTH_);
  if (!isRecordQueryShortCode_(shortCode)) {
    throw createAppError_('RECORD_QUERY_SHORT_CODE_INVALID', false, '查詢連結無效。');
  }
  return shortCode;
}

function hashRecordQueryShortCode_(shortCode) {
  if (!isRecordQueryShortCode_(shortCode)) {
    throw createAppError_('RECORD_QUERY_SHORT_CODE_INVALID', false, '查詢連結無效。');
  }
  return hmacHex_(
    getRequiredProperty_(APP_CONFIG_KEYS_.IDENTIFIER_HASH_SECRET),
    'RECORD_QUERY_SHORT_CODE:' + shortCode
  );
}

function getRecordQueryShortPropertyKey_(shortCodeHash) {
  if (typeof shortCodeHash !== 'string' || !/^[a-f0-9]{64}$/.test(shortCodeHash)) {
    throw createAppError_('RECORD_QUERY_SHORT_CODE_INVALID', false, '查詢連結無效。');
  }
  return RECORD_QUERY_PROPERTY_PREFIX_ + 'SHORT_' + shortCodeHash;
}

function buildRecordQueryShortUrl_(baseUrl, shortCode) {
  if (typeof baseUrl !== 'string' || !/^https:\/\//i.test(baseUrl) || !isRecordQueryShortCode_(shortCode)) {
    throw createAppError_('RECORD_QUERY_SHORT_CODE_INVALID', false, '查詢連結無效。');
  }
  var separator = baseUrl.indexOf('?') >= 0 ? '&' : '?';
  return baseUrl + separator + 'route=q&id=' + encodeURIComponent(shortCode);
}

function saveRecordQueryShortCode_(shortCode, record) {
  var shortCodeHash = hashRecordQueryShortCode_(shortCode);
  var safeRecord = {
    shortCodeHash: shortCodeHash,
    lineUserHash: record.lineUserHash,
    groupIdHash: record.groupIdHash || '',
    startDate: record.startDate || '',
    endDate: record.endDate || '',
    expiresAt: record.expiresAt,
    nonce: record.nonce,
    scope: record.scope
  };
  PropertiesService.getScriptProperties().setProperty(
    getRecordQueryShortPropertyKey_(shortCodeHash),
    JSON.stringify(safeRecord)
  );
}

function verifyRecordQueryShortCode_(shortCode) {
  var shortCodeHash = hashRecordQueryShortCode_(shortCode);
  var propertyKey = getRecordQueryShortPropertyKey_(shortCodeHash);
  var rawRecord = PropertiesService.getScriptProperties().getProperty(propertyKey);
  var record = null;
  try {
    record = rawRecord ? JSON.parse(rawRecord) : null;
  } catch (error) {
    record = null;
  }
  if (
    !record ||
    record.shortCodeHash !== shortCodeHash ||
    !/^[a-f0-9]{64}$/.test(String(record.lineUserHash || '')) ||
    (record.groupIdHash && !/^[a-f0-9]{64}$/.test(String(record.groupIdHash))) ||
    !Number.isSafeInteger(Number(record.expiresAt)) ||
    typeof record.nonce !== 'string' ||
    !/^[a-f0-9]{32}$/.test(record.nonce) ||
    ['personal-record-query', 'group-record-query'].indexOf(record.scope) < 0
  ) {
    throw createAppError_('RECORD_QUERY_TOKEN_INVALID', false, '查詢連結無效。');
  }
  if (Number(record.expiresAt) <= Date.now()) {
    var expiredError = createAppError_('RECORD_QUERY_TOKEN_EXPIRED', false, '查詢連結已過期。');
    expiredError.queryScope = record.scope;
    throw expiredError;
  }
  return {
    version: 3,
    lineUserHash: record.lineUserHash,
    groupIdHash: record.groupIdHash || '',
    startDate: record.startDate || '',
    endDate: record.endDate || '',
    expiresAt: Number(record.expiresAt),
    nonce: record.nonce,
    scope: record.scope,
    shortCodeHash: shortCodeHash
  };
}

function verifyRecordQueryAccess_(tokenOrShortCode) {
  if (isRecordQueryShortCode_(tokenOrShortCode)) {
    return verifyRecordQueryShortCode_(tokenOrShortCode);
  }
  return verifyRecordQueryToken_(tokenOrShortCode);
}

function createRecordQueryShortLink_(lineUserHash, groupIdHash, startDate, endDate) {
  var isGroup = Boolean(groupIdHash);
  var nonce = Utilities.getUuid().replace(/-/g, '').toLowerCase();
  var expiresAt = Date.now() + RECORD_QUERY_TOKEN_TTL_MILLISECONDS_;
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    cleanupExpiredRecordQueryTokens_();
    var shortCode = '';
    for (var attempt = 0; attempt < 5; attempt += 1) {
      var candidate = createRecordQueryShortCode_();
      var candidateHash = hashRecordQueryShortCode_(candidate);
      if (!PropertiesService.getScriptProperties().getProperty(getRecordQueryShortPropertyKey_(candidateHash))) {
        shortCode = candidate;
        break;
      }
    }
    if (!shortCode) {
      throw createAppError_('RECORD_QUERY_SHORT_CODE_COLLISION', true, '查詢連結暫時無法建立，請稍後再試。');
    }
    saveRecordQueryShortCode_(shortCode, {
      lineUserHash: lineUserHash,
      groupIdHash: groupIdHash || '',
      startDate: startDate || '',
      endDate: endDate || '',
      expiresAt: expiresAt,
      nonce: nonce,
      scope: isGroup ? 'group-record-query' : 'personal-record-query'
    });
  } finally {
    lock.releaseLock();
  }
  var baseUrl = getRequiredProperty_(APP_CONFIG_KEYS_.APP_BASE_URL);
  return buildRecordQueryShortUrl_(baseUrl, shortCode);
}

function createRecordQueryToken_(lineUserHash, expiresAt, nonce, secret, groupIdHash, startDate, endDate) {
  if (
    typeof lineUserHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(lineUserHash) ||
    !Number.isSafeInteger(expiresAt) ||
    typeof nonce !== 'string' ||
    !/^[a-f0-9]{32}$/.test(nonce)
  ) {
    throw createAppError_('RECORD_QUERY_TOKEN_INVALID', false, '查詢連結無效。');
  }
  if (groupIdHash !== undefined && groupIdHash !== null && !/^[a-f0-9]{64}$/.test(String(groupIdHash))) {
    throw createAppError_('RECORD_QUERY_TOKEN_INVALID', false, '查詢連結無效。');
  }
  var payload = {
    version: groupIdHash ? 2 : 1,
    lineUserHash: lineUserHash,
    expiresAt: expiresAt,
    nonce: nonce
  };
  if (groupIdHash) {
    payload.groupIdHash = String(groupIdHash);
    if (startDate) {
      payload.startDate = startDate;
    }
    if (endDate) {
      payload.endDate = endDate;
    }
  }
  var encodedPayload = encodeRecordQueryPayload_(payload);
  return encodedPayload + '.' + hmacHex_(String(secret), encodedPayload);
}

function cleanupExpiredRecordQueryTokens_() {
  var properties = PropertiesService.getScriptProperties();
  var allProperties = properties.getProperties();
  var now = Date.now();
  var deletedCount = 0;
  Object.keys(allProperties).forEach(function (key) {
    if (key.indexOf(RECORD_QUERY_PROPERTY_PREFIX_) !== 0) {
      return;
    }
    var record = null;
    try {
      record = JSON.parse(allProperties[key]);
    } catch (error) {
      record = null;
    }
    if (!record || Number(record.expiresAt) <= now) {
      properties.deleteProperty(key);
      deletedCount += 1;
    }
  });
  return deletedCount;
}

function createRecordQueryLink_(lineUserHash) {
  var user = findUserByHash_(lineUserHash);
  if (!isApprovedEnabledUser_(user) || !user.SheetId) {
    throw createAppError_('RECORD_QUERY_NOT_AVAILABLE', false, '請先完成 Google 帳號綁定後再查詢紀錄。');
  }
  return '請在 10 分鐘內開啟 LINE 記錄搜尋中心：\n' +
    createRecordQueryShortLink_(lineUserHash, '', '', '');
}

function createGroupRecordQueryLink_(lineUserHash, groupIdHash, startDate, endDate) {
  if (!/^[a-f0-9]{64}$/.test(String(groupIdHash || ''))) {
    throw createAppError_('GROUP_QUERY_TOKEN_INVALID', false, '群組查詢連結無效。');
  }
  var group = findEnabledGroupByHash_(groupIdHash);
  if (!group) {
    throw createAppError_('GROUP_QUERY_NOT_AVAILABLE', false, '找不到可查詢的群組。');
  }
  if (!isAdminLineUserHash_(lineUserHash) && group.OwnerLineUserHash !== lineUserHash) {
    throw createAppError_('GROUP_QUERY_NOT_AVAILABLE', false, '你目前沒有可查詢完整紀錄的群組。完整群組紀錄僅限群組備份擁有者查詢。');
  }
  var owner = findEnabledUserByHash_(group.OwnerLineUserHash);
  if (!owner || !owner.SheetId) {
    throw createAppError_('GROUP_QUERY_NOT_AVAILABLE', false, '找不到可查詢的群組。');
  }
  var normalizedStart = startDate || '';
  var normalizedEnd = endDate || '';
  if (normalizedStart && !/^\d{4}-\d{2}-\d{2}$/.test(normalizedStart)) {
    throw createAppError_('GROUP_QUERY_FILTER_INVALID', false, '查詢日期格式不正確。');
  }
  if (normalizedEnd && !/^\d{4}-\d{2}-\d{2}$/.test(normalizedEnd)) {
    throw createAppError_('GROUP_QUERY_FILTER_INVALID', false, '查詢日期格式不正確。');
  }
  return '請在 10 分鐘內開啟群組完整記錄搜尋中心：\n' +
    createRecordQueryShortLink_(lineUserHash, groupIdHash, normalizedStart, normalizedEnd);
}

function decodeRecordQueryPayload_(encodedPayload) {
  try {
    var bytes = Utilities.base64DecodeWebSafe(encodedPayload);
    return JSON.parse(Utilities.newBlob(bytes).getDataAsString('UTF-8'));
  } catch (error) {
    throw createAppError_('RECORD_QUERY_TOKEN_INVALID', false, '查詢連結無效。');
  }
}

function isRecordQueryPayloadValid_(payload, nowMilliseconds) {
  var now = Number.isSafeInteger(nowMilliseconds) ? nowMilliseconds : Date.now();
  return Boolean(
    payload &&
    (payload.version === 1 || payload.version === 2) &&
    typeof payload.lineUserHash === 'string' &&
    /^[a-f0-9]{64}$/.test(payload.lineUserHash) &&
    Number.isSafeInteger(payload.expiresAt) &&
    payload.expiresAt > now &&
    typeof payload.nonce === 'string' &&
    /^[a-f0-9]{32}$/.test(payload.nonce) &&
    (payload.version === 1 || (
      typeof payload.groupIdHash === 'string' &&
      /^[a-f0-9]{64}$/.test(payload.groupIdHash) &&
      (!payload.startDate || /^\d{4}-\d{2}-\d{2}$/.test(payload.startDate)) &&
      (!payload.endDate || /^\d{4}-\d{2}-\d{2}$/.test(payload.endDate))
    ))
  );
}

function verifyRecordQueryToken_(token) {
  if (typeof token !== 'string' || token.length > 2000) {
    throw createAppError_('RECORD_QUERY_TOKEN_INVALID', false, '查詢連結無效。');
  }
  var parts = token.split('.');
  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
    !/^[a-f0-9]{64}$/.test(parts[1])
  ) {
    throw createAppError_('RECORD_QUERY_TOKEN_INVALID', false, '查詢連結無效。');
  }
  var expectedSignature = hmacHex_(getRequiredProperty_(APP_CONFIG_KEYS_.BIND_TOKEN_SECRET), parts[0]);
  if (!constantTimeEqual_(expectedSignature, parts[1])) {
    throw createAppError_('RECORD_QUERY_TOKEN_INVALID', false, '查詢連結無效。');
  }
  var payload = decodeRecordQueryPayload_(parts[0]);
  if (!isRecordQueryPayloadValid_(payload)) {
    if (payload && Number.isSafeInteger(payload.expiresAt) && payload.expiresAt <= Date.now()) {
      throw createAppError_('RECORD_QUERY_TOKEN_EXPIRED', false, '查詢連結已過期。');
    }
    throw createAppError_('RECORD_QUERY_TOKEN_INVALID', false, '查詢連結無效。');
  }
  var propertyKey = getRecordQueryPropertyKey_(payload.nonce);
  var rawRecord = PropertiesService.getScriptProperties().getProperty(propertyKey);
  var record = null;
  try {
    record = rawRecord ? JSON.parse(rawRecord) : null;
  } catch (error) {
    record = null;
  }
  if (
    !record ||
    record.lineUserHash !== payload.lineUserHash ||
    String(record.groupIdHash || '') !== String(payload.groupIdHash || '') ||
    Number(record.expiresAt) !== payload.expiresAt ||
    record.tokenHash !== hashRecordQueryToken_(token)
  ) {
    throw createAppError_('RECORD_QUERY_TOKEN_INVALID', false, '查詢連結無效。');
  }
  return payload;
}

function normalizeRecordQueryFilters_(filters) {
  var source = filters && typeof filters === 'object' ? filters : {};
  var startDate = source.startDate || '';
  var endDate = source.endDate || '';
  var keyword = source.keyword || '';
  var type = source.type || 'all';
  if (typeof startDate !== 'string' || (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate))) {
    throw createAppError_('RECORD_QUERY_FILTER_INVALID', false, '查詢日期格式不正確。');
  }
  if (typeof endDate !== 'string' || (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate))) {
    throw createAppError_('RECORD_QUERY_FILTER_INVALID', false, '查詢日期格式不正確。');
  }
  if (startDate && endDate && startDate > endDate) {
    throw createAppError_('RECORD_QUERY_FILTER_INVALID', false, '查詢起訖日期不正確。');
  }
  if (typeof keyword !== 'string' || keyword.length > 100) {
    throw createAppError_('RECORD_QUERY_FILTER_INVALID', false, '查詢關鍵字過長。');
  }
  if (RECORD_QUERY_TYPES_.indexOf(type) < 0) {
    throw createAppError_('RECORD_QUERY_FILTER_INVALID', false, '查詢類型不正確。');
  }
  return {
    startDate: startDate,
    endDate: endDate,
    keyword: keyword.trim().toLowerCase(),
    type: type
  };
}

function getRecordQueryType_(sourceType, messageType) {
  if (sourceType === '群組' && messageType === 'text') {
    return 'note';
  }
  return messageType || 'text';
}

function sanitizeRecordQueryText_(value, maximumLength) {
  return String(value || '')
    .replace(/\b[UC][a-f0-9]{32}\b/gi, '[已隱藏識別]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[已隱藏信箱]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[已隱藏雜湊]')
    .slice(0, maximumLength || 500);
}

function getRecordQueryField_(record, fieldName) {
  if (record && !Array.isArray(record) && typeof record === 'object') {
    return record[fieldName];
  }
  return '';
}

function matchesRecordQueryFilters_(record, filters) {
  var messageTime = String(getRecordQueryField_(record, 'LINE 訊息時間') || '');
  var datePart = messageTime.slice(0, 10);
  var sourceType = String(getRecordQueryField_(record, '來源類型') || '');
  var groupName = String(getRecordQueryField_(record, '群組名稱') || '');
  var messageType = String(getRecordQueryField_(record, '訊息類型') || 'text');
  var recordType = getRecordQueryType_(sourceType, messageType);
  if (filters.startDate && datePart < filters.startDate) {
    return false;
  }
  if (filters.endDate && datePart > filters.endDate) {
    return false;
  }
  if (filters.type !== 'all' && recordType !== filters.type) {
    return false;
  }
  if (filters.keyword) {
    var searchable = [
      getRecordQueryField_(record, '傳送者名稱'),
      groupName,
      getRecordQueryField_(record, '原始檔名'),
      getRecordQueryField_(record, '文字內容'),
      getRecordQueryField_(record, '網址'),
      getRecordQueryField_(record, '標籤')
    ]
      .map(function (value) { return String(value || '').toLowerCase(); })
      .join('\n');
    if (searchable.indexOf(filters.keyword) < 0) {
      return false;
    }
  }
  return true;
}

function mapRecordQueryRow_(record) {
  var sourceType = String(getRecordQueryField_(record, '來源類型') || '');
  var messageType = String(getRecordQueryField_(record, '訊息類型') || 'text');
  return {
    time: sanitizeRecordQueryText_(getRecordQueryField_(record, 'LINE 訊息時間'), 40),
    name: sanitizeRecordQueryText_(getRecordQueryField_(record, '原始檔名') || messageType, 180),
    senderName: sanitizeRecordQueryText_(getRecordQueryField_(record, '傳送者名稱'), 120),
    groupName: sourceType === '群組'
      ? sanitizeRecordQueryText_(getRecordQueryField_(record, '群組名稱'), 180)
      : '',
    message: sanitizeRecordQueryText_(getRecordQueryField_(record, '文字內容'), 1000),
    note: sanitizeRecordQueryText_(getRecordQueryField_(record, '錯誤訊息'), 500),
    status: sanitizeRecordQueryText_(getRecordQueryField_(record, '狀態'), 80),
    url: sanitizeRecordQueryText_(getRecordQueryField_(record, '網址'), 500),
    tags: sanitizeRecordQueryText_(getRecordQueryField_(record, '標籤'), 300),
    driveLink: typeof getRecordQueryField_(record, 'Drive 連結') === 'string' &&
      /^https:\/\//.test(getRecordQueryField_(record, 'Drive 連結'))
      ? getRecordQueryField_(record, 'Drive 連結')
      : '',
    type: getRecordQueryType_(sourceType, messageType)
  };
}

/** 由 HTML 頁面呼叫；每次查詢都重新驗證短效 Token 與使用者身分。 */
function searchRecords(token, filters) {
  var payload = verifyRecordQueryAccess_(token);
  var group = payload.groupIdHash ? findEnabledGroupByHash_(payload.groupIdHash) : null;
  if (payload.groupIdHash && !group) {
    throw createAppError_('GROUP_QUERY_NOT_AVAILABLE', false, '群組查詢連結已失效。');
  }
  if (group && !isAdminLineUserHash_(payload.lineUserHash) && group.OwnerLineUserHash !== payload.lineUserHash) {
    throw createAppError_('GROUP_QUERY_NOT_AVAILABLE', false, '你目前沒有可查詢完整紀錄的群組。');
  }
  if (payload.scope === 'group-record-query' && !group) {
    throw createAppError_('GROUP_QUERY_NOT_AVAILABLE', false, '群組查詢連結已失效。');
  }
  if (payload.scope === 'personal-record-query' && group) {
    throw createAppError_('RECORD_QUERY_TOKEN_INVALID', false, '查詢連結無效。');
  }
  var user = findUserByHash_(group ? group.OwnerLineUserHash : payload.lineUserHash);
  if (!isApprovedEnabledUser_(user) || !user.SheetId) {
    throw createAppError_('RECORD_QUERY_NOT_AVAILABLE', false, '請先完成 Google 帳號綁定後再查詢紀錄。');
  }
  var normalizedFilters = normalizeRecordQueryFilters_(filters);
  var accessToken = getUserAccessToken_(user.LineUserHash);
  var response = googleApiFetch_(
    'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(user.SheetId) +
      '/values/' + encodeURIComponent('備份紀錄!A:AZ'),
    { method: 'get' },
    accessToken,
    'RECORD_QUERY_READ_FAILED'
  );
  var result = parseJsonResponse_(response, 'RECORD_QUERY_RESPONSE_INVALID');
  var values = Array.isArray(result.values) ? result.values : [];
  var headers = Array.isArray(values[0]) ? values[0].map(function (header) {
    return String(header || '').trim();
  }) : [];
  var records = values.slice(1).map(function (row) {
    var record = {};
    if (!Array.isArray(row)) {
      return record;
    }
    headers.forEach(function (header, index) {
      if (header) {
        record[header] = row[index] || '';
      }
    });
    return record;
  });
  var legacyGroupRecordsUsed = false;
  if (group) {
    var canUseLegacyFallback = canUseLegacyGroupNameFallback_(group);
    var hasLegacyGroupRecords = records.some(function (row) {
      return isGroupRecordSource_(row) &&
        !String(getRecordQueryField_(row, '群組識別') || '').trim();
    });
    if (hasLegacyGroupRecords && !canUseLegacyFallback) {
      throw createAppError_('GROUP_IDENTIFIER_MISSING', false, '舊紀錄缺少群組識別，且群組名稱無法唯一確認，請僅查詢新版本後的群組紀錄。');
    }
    records = records.filter(function (row) {
      if (!isGroupRecordSource_(row)) {
        return false;
      }
      if (String(getRecordQueryField_(row, '群組識別') || '') === group.GroupIdHash) {
        return true;
      }
      if (canUseLegacyFallback && isLegacyGroupRecordForGroup_(row, group)) {
        legacyGroupRecordsUsed = true;
        return true;
      }
      return false;
    });
  }
  if (group && payload.startDate && !normalizedFilters.startDate) {
    normalizedFilters.startDate = payload.startDate;
  }
  if (group && payload.endDate && !normalizedFilters.endDate) {
    normalizedFilters.endDate = payload.endDate;
  }
  var mappedRows = records
    .filter(function (row) {
      return matchesRecordQueryFilters_(row, normalizedFilters);
    })
    .slice(0, 100)
    .map(mapRecordQueryRow_);
  return {
    rows: mappedRows,
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(user.SheetId) + '/edit',
    notice: legacyGroupRecordsUsed
      ? '部分舊紀錄因早期版本缺少群組識別，已依群組名稱相容查詢。'
      : ''
  };
}
