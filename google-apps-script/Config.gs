/** 集中讀取 Script Properties，所有 Secret 都只能在部署後由管理者設定。 */
var APP_CONFIG_KEYS_ = Object.freeze({
  GOOGLE_OAUTH_CLIENT_ID: 'GOOGLE_OAUTH_CLIENT_ID',
  GOOGLE_OAUTH_CLIENT_SECRET: 'GOOGLE_OAUTH_CLIENT_SECRET',
  LINE_CHANNEL_ACCESS_TOKEN: 'LINE_CHANNEL_ACCESS_TOKEN',
  WORKER_GAS_SHARED_SECRET: 'WORKER_GAS_SHARED_SECRET',
  BIND_TOKEN_SECRET: 'BIND_TOKEN_SECRET',
  IDENTIFIER_HASH_SECRET: 'IDENTIFIER_HASH_SECRET',
  ADMIN_SPREADSHEET_ID: 'ADMIN_SPREADSHEET_ID',
  MAX_FILE_SIZE_BYTES: 'MAX_FILE_SIZE_BYTES',
  APP_BASE_URL: 'APP_BASE_URL',
  DELETE_DRIVE_ON_UNSEND: 'DELETE_DRIVE_ON_UNSEND',
  ERROR_RETENTION_DAYS: 'ERROR_RETENTION_DAYS',
  COMPLETED_JOB_RETENTION_DAYS: 'COMPLETED_JOB_RETENTION_DAYS',
  JOB_PROCESSING_LEASE_SECONDS: 'JOB_PROCESSING_LEASE_SECONDS',
  HMAC_DIAGNOSTIC_ENABLED: 'HMAC_DIAGNOSTIC_ENABLED',
  ADMIN_LINE_USER_HASHES: 'ADMIN_LINE_USER_HASHES',
  ENABLE_SELF_SERVICE_BINDING: 'ENABLE_SELF_SERVICE_BINDING',
  REQUIRE_ADMIN_APPROVAL: 'REQUIRE_ADMIN_APPROVAL'
});

function isHmacDiagnosticEnabled_() {
  return PropertiesService.getScriptProperties()
    .getProperty(APP_CONFIG_KEYS_.HMAC_DIAGNOSTIC_ENABLED) === 'true';
}

function isSelfServiceBindingEnabled_() {
  return PropertiesService.getScriptProperties()
    .getProperty(APP_CONFIG_KEYS_.ENABLE_SELF_SERVICE_BINDING) === 'true';
}

function isAdminApprovalRequired_() {
  var value = PropertiesService.getScriptProperties()
    .getProperty(APP_CONFIG_KEYS_.REQUIRE_ADMIN_APPROVAL);
  return value !== 'false';
}

function getAdminLineUserHashes_() {
  var rawValue = PropertiesService.getScriptProperties()
    .getProperty(APP_CONFIG_KEYS_.ADMIN_LINE_USER_HASHES) || '';
  if (!rawValue.trim()) {
    return [];
  }
  var hashes = rawValue.split(',').map(function (value) { return value.trim().toLowerCase(); });
  if (hashes.some(function (value) { return !/^[a-f0-9]{64}$/.test(value); })) {
    throw createAppError_('CONFIG_INVALID_ADMIN_USERS', false, '管理者設定格式無效。');
  }
  return hashes.filter(function (value, index) { return hashes.indexOf(value) === index; });
}

function isAdminLineUserHash_(lineUserHash) {
  return isAdminLineUserHashConfigured_(lineUserHash, getAdminLineUserHashes_());
}

function isAdminLineUserHashConfigured_(lineUserHash, configuredHashes) {
  return typeof lineUserHash === 'string' &&
    /^[a-f0-9]{64}$/.test(lineUserHash) &&
    Array.isArray(configuredHashes) &&
    configuredHashes.indexOf(lineUserHash) >= 0;
}

function getRequiredProperty_(name) {
  var value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value || !String(value).trim()) {
    throw createAppError_('CONFIG_MISSING', false, '系統設定不完整。');
  }
  return String(value).trim();
}

function getMaxFileSizeBytes_() {
  var rawValue = getRequiredProperty_(APP_CONFIG_KEYS_.MAX_FILE_SIZE_BYTES);
  if (!/^\d+$/.test(rawValue)) {
    throw createAppError_('CONFIG_INVALID_FILE_LIMIT', false, '檔案大小設定無效。');
  }
  var parsedValue = Number(rawValue);
  var platformSafetyMaximum = 49 * 1024 * 1024;
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0 || parsedValue > platformSafetyMaximum) {
    throw createAppError_('CONFIG_INVALID_FILE_LIMIT', false, '檔案大小設定無效。');
  }
  return parsedValue;
}

function shouldDeleteDriveFileOnUnsend_() {
  return PropertiesService.getScriptProperties()
    .getProperty(APP_CONFIG_KEYS_.DELETE_DRIVE_ON_UNSEND) === 'true';
}

function getJobProcessingLeaseSeconds_() {
  var rawValue = PropertiesService.getScriptProperties()
    .getProperty(APP_CONFIG_KEYS_.JOB_PROCESSING_LEASE_SECONDS);
  if (!rawValue) {
    return 600;
  }
  if (!/^\d+$/.test(rawValue)) {
    throw createAppError_('CONFIG_INVALID_JOB_LEASE', false, '工作租約秒數設定無效。');
  }
  var parsedValue = Number(rawValue);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < 60 || parsedValue > 3600) {
    throw createAppError_('CONFIG_INVALID_JOB_LEASE', false, '工作租約秒數設定無效。');
  }
  return parsedValue;
}

function getRetentionDays_(propertyName, fallbackDays) {
  var rawValue = PropertiesService.getScriptProperties().getProperty(propertyName);
  if (!rawValue) {
    return fallbackDays;
  }
  if (!/^\d+$/.test(rawValue)) {
    throw createAppError_('CONFIG_INVALID_RETENTION_DAYS', false, '管理資料保留天數設定無效。');
  }
  var parsedValue = Number(rawValue);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < 1 || parsedValue > 3650) {
    throw createAppError_('CONFIG_INVALID_RETENTION_DAYS', false, '管理資料保留天數設定無效。');
  }
  return parsedValue;
}

function parseStoredDateMilliseconds_(value) {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value !== 'string' || value.length === 0) {
    return NaN;
  }
  var normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + '+08:00'
    : value;
  return new Date(normalized).getTime();
}

function getTaipeiNow_() {
  return Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
}

function formatTaipeiTime_(milliseconds) {
  return Utilities.formatDate(new Date(milliseconds), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
}
