function assertTest_(condition, message) {
  if (!condition) {
    throw new Error('測試失敗：' + message);
  }
}

function getOwnerAuthorizationHealthRequiredKeys_() {
  return [
    APP_CONFIG_KEYS_.ADMIN_SPREADSHEET_ID,
    APP_CONFIG_KEYS_.WORKER_GAS_SHARED_SECRET,
    APP_CONFIG_KEYS_.IDENTIFIER_HASH_SECRET,
    APP_CONFIG_KEYS_.BIND_TOKEN_SECRET,
    APP_CONFIG_KEYS_.LINE_CHANNEL_ACCESS_TOKEN,
    APP_CONFIG_KEYS_.GOOGLE_OAUTH_CLIENT_ID,
    APP_CONFIG_KEYS_.GOOGLE_OAUTH_CLIENT_SECRET,
    APP_CONFIG_KEYS_.MAX_FILE_SIZE_BYTES,
    APP_CONFIG_KEYS_.APP_BASE_URL
  ];
}

/** 部署後由管理者手動執行；只觸發必要授權與唯讀檢查，不建立備份資源。 */
function testOwnerAuthorizationHealth() {
  try {
    var properties = PropertiesService.getScriptProperties();
    var requiredKeys = getOwnerAuthorizationHealthRequiredKeys_();
    var missingKeys = requiredKeys.filter(function (key) {
      var value = properties.getProperty(key);
      return !value || !String(value).trim();
    });
    if (missingKeys.length > 0) {
      throw createAppError_('OWNER_AUTH_CONFIG_MISSING', false, '必要設定尚未完成。');
    }

    var adminSpreadsheetId = String(
      properties.getProperty(APP_CONFIG_KEYS_.ADMIN_SPREADSHEET_ID)
    ).trim();
    try {
      var spreadsheet = SpreadsheetApp.openById(adminSpreadsheetId);
      spreadsheet.getName();
    } catch (spreadsheetError) {
      throw createAppError_('OWNER_AUTH_SPREADSHEET_FAILED', false, '管理試算表授權檢查失敗。');
    }

    try {
      var response = UrlFetchApp.fetch('https://www.google.com/robots.txt', {
        method: 'get',
        followRedirects: true,
        muteHttpExceptions: true
      });
      if (response.getResponseCode() >= 500) {
        throw createAppError_('OWNER_AUTH_URLFETCH_FAILED', true, '外部請求授權檢查失敗。');
      }
    } catch (urlFetchError) {
      if (isAppError_(urlFetchError)) {
        throw urlFetchError;
      }
      throw createAppError_('OWNER_AUTH_URLFETCH_FAILED', true, '外部請求授權檢查失敗。');
    }

    try {
      var scriptId = ScriptApp.getScriptId();
      var timeZone = Session.getScriptTimeZone();
      if (!scriptId || !timeZone) {
        throw createAppError_('OWNER_AUTH_SCRIPT_FAILED', false, 'Apps Script 授權檢查失敗。');
      }
    } catch (scriptError) {
      if (isAppError_(scriptError)) {
        throw scriptError;
      }
      throw createAppError_('OWNER_AUTH_SCRIPT_FAILED', false, 'Apps Script 授權檢查失敗。');
    }

    Logger.log('PASS testOwnerAuthorizationHealth');
  } catch (error) {
    var appError = isAppError_(error)
      ? error
      : createAppError_('OWNER_AUTH_HEALTH_FAILED', false, '擁有者授權健康檢查失敗。');
    Logger.log('FAIL testOwnerAuthorizationHealth：' + appError.appCode);
    throw appError;
  }
}

function testOwnerAuthorizationHealthHelpers() {
  var keys = getOwnerAuthorizationHealthRequiredKeys_();
  assertTest_(keys.indexOf(APP_CONFIG_KEYS_.ADMIN_SPREADSHEET_ID) >= 0, '健康檢查應驗證管理試算表設定。');
  assertTest_(keys.indexOf(APP_CONFIG_KEYS_.WORKER_GAS_SHARED_SECRET) >= 0, '健康檢查應驗證 Worker HMAC 設定。');
  assertTest_(typeof testOwnerAuthorizationHealth === 'function', '健康檢查必須是全域函式。');
  Logger.log('PASS testOwnerAuthorizationHealthHelpers：設定鍵與唯讀授權檢查入口。');
}

function testOAuthServiceConsistency() {
  var lineUserHash = 'a'.repeat(64);
  var existingUser = {
    GoogleSubjectId: 'mock-subject',
    RootFolderId: 'root_mock_1',
    PersonalFolderId: 'personal_mock_1',
    GroupFolderId: 'group_mock_1',
    SheetId: 'sheet_mock_1',
    Enabled: true,
    ApprovalStatus: USER_APPROVAL_STATUS_.APPROVED
  };
  assertTest_(getOAuthServiceName_(lineUserHash) === 'LineUser_' + lineUserHash,
    'OAuth Service 名稱必須集中使用 LineUser_<lineUserHash>。');
  assertTest_(hasCompleteUserResources_(existingUser),
    '重新授權測試使用者應具備可重用的既有 Drive／Sheet 資源。');
  assertTest_(determineBindingApprovalStatus_({ InviteCodeHash: '' }, existingUser) === USER_APPROVAL_STATUS_.APPROVED,
    '既有核准使用者重新授權後應維持 APPROVED。');
  assertTest_(isApprovedEnabledUser_(existingUser),
    '既有核准使用者重新授權後應維持 Enabled=true。');
  Logger.log('PASS testOAuthServiceConsistency：OAuth Service、Token 讀取路徑與既有資源重用規則一致。');
}

/** 使用者設定 TEST_LINE_USER_HASH 後手動執行；只讀取 hasAccess，不輸出 Token 或識別資料。 */
function testOAuthTokenAvailableForConfiguredUser() {
  var lineUserHash = PropertiesService.getScriptProperties().getProperty('TEST_LINE_USER_HASH') || '';
  if (!/^[a-f0-9]{64}$/.test(lineUserHash)) {
    throw new Error('測試需要 64 碼 TEST_LINE_USER_HASH Script Property。');
  }
  var service = getGoogleOAuthService_(lineUserHash);
  var hasAccess = service.hasAccess();
  logOAuthTokenState_(lineUserHash, hasAccess, hasAccess ? 'TEST_TOKEN_AVAILABLE' : 'TEST_TOKEN_MISSING', 'manual-oauth-test');
  assertTest_(hasAccess, '目前使用者 OAuth Token 不存在，請先完成「重新授權」。');
  Logger.log('PASS testOAuthTokenAvailableForConfiguredUser：OAuth Token 已存在且可由共用 Service 讀取。');
}

function testHmacVerification() {
  ensureAdminSheets_();
  testEnvelopeHmacFixedVector();
  var timestamp = Date.now();
  var nonce = Utilities.getUuid().replace(/-/g, '').toLowerCase();
  var payload = JSON.stringify({ test: true });
  var sharedSecret = getRequiredProperty_(APP_CONFIG_KEYS_.WORKER_GAS_SHARED_SECRET);
  var signature = computeWorkerEnvelopeSignature_(timestamp, nonce, payload, sharedSecret);
  var verifiedPayload = verifyWorkerEnvelope_({
    timestamp: timestamp,
    nonce: nonce,
    payload: payload,
    signature: signature
  });
  assertTest_(verifiedPayload === payload, '合法 HMAC 應通過驗證。');

  // 使用尚未消耗的新 timestamp 與 nonce，避免驗證流程受到前一個 Nonce 影響。
  var tamperedTimestamp = timestamp + 1;
  var tamperedNonce = Utilities.getUuid().replace(/-/g, '').toLowerCase();
  var expectedTamperedSignature = computeWorkerEnvelopeSignature_(
    tamperedTimestamp,
    tamperedNonce,
    payload,
    sharedSecret
  );
  var lastCharacter = expectedTamperedSignature.slice(-1);
  var replacementCharacter = lastCharacter === '0' ? '1' : '0';
  var tamperedSignature = expectedTamperedSignature.slice(0, -1) + replacementCharacter;
  assertTest_(!constantTimeEqual_(tamperedSignature, expectedTamperedSignature), '竄改簽章應失敗。');

  var tamperedErrorCode = '';
  try {
    verifyWorkerEnvelope_({
      timestamp: tamperedTimestamp,
      nonce: tamperedNonce,
      payload: payload,
      signature: tamperedSignature
    });
  } catch (error) {
    tamperedErrorCode = error && error.appCode;
  }
  assertTest_(tamperedErrorCode === 'SIGNATURE_INVALID', '竄改簽章應拋出 SIGNATURE_INVALID。');

  var payloadTamperTimestamp = timestamp + 2;
  var payloadTamperNonce = Utilities.getUuid().replace(/-/g, '').toLowerCase();
  var payloadTamperSignature = computeWorkerEnvelopeSignature_(
    payloadTamperTimestamp,
    payloadTamperNonce,
    payload,
    sharedSecret
  );
  var payloadTamperErrorCode = '';
  try {
    verifyWorkerEnvelope_({
      timestamp: payloadTamperTimestamp,
      nonce: payloadTamperNonce,
      payload: payload + ' ',
      signature: payloadTamperSignature
    });
  } catch (error) {
    payloadTamperErrorCode = error && error.appCode;
  }
  assertTest_(payloadTamperErrorCode === 'SIGNATURE_INVALID', '竄改 Payload 應拋出 SIGNATURE_INVALID。');
  console.log('HMAC 驗證測試通過。');
}

function testEnvelopeHmacFixedVector() {
  var timestamp = '2026-08-06T12:30:00.000Z';
  var nonce = '0123456789abcdef0123456789abcdef';
  // 固定字串常值，避免 JSON.stringify 改變欄位順序或 escaping。
  var payload = '{"message":"繁體中文測試","ok":true}';
  var expectedSignature =
    '5f3da90b2c65bf73c265fc32e667555e179dd65d9b3d3667c7b7c64ed8d6a9ca';
  var signature = computeWorkerEnvelopeSignature_(
    timestamp,
    nonce,
    payload,
    'TEST_SECRET_1234567890'
  );
  assertTest_(
    signature === expectedSignature,
    'Worker 與 GAS Envelope HMAC 固定向量不一致。'
  );
  console.log('Envelope HMAC UTF-8 固定向量測試通過。');
}

function testBackupSuccessReplyMessages() {
  var cases = [
    { messageType: 'text', expected: '✅ 文字已備份' },
    { messageType: 'image', expected: '✅ 圖片已備份' },
    { messageType: 'video', expected: '✅ 影片已備份' },
    { messageType: 'audio', expected: '✅ 音訊已備份' },
    { messageType: 'file', fileName: '報告:2026.pdf', expected: '✅ 檔案已備份：報告_2026.pdf' }
  ];
  cases.forEach(function (testCase) {
    var job = {
      command: null,
      groupIdHash: null,
      senderDisplayName: '測試使用者',
      groupDisplayName: null,
      messageType: testCase.messageType,
      fileName: testCase.fileName || null
    };
    assertTest_(
      getBackupSuccessReplyMessage_(job) === testCase.expected,
      '個人 ' + testCase.messageType + ' 成功回覆不正確。'
    );
  });
  assertTest_(
    getBackupSuccessReplyMessage_({
      command: null,
      groupIdHash: 'a'.repeat(64),
      messageType: 'image',
      fileName: null
    }) === null,
    '群組附件成功預設不可回覆。'
  );
  assertTest_(
    getBackupSuccessReplyMessage_({
      command: 'note',
      groupIdHash: 'a'.repeat(64),
      messageType: 'text',
      fileName: null
    }) === '✅ 筆記已備份。',
    '群組筆記成功應可回覆。'
  );
  console.log('備份成功 Reply 訊息測試通過。');
}

function enableHmacDiagnosticMode() {
  PropertiesService.getScriptProperties()
    .setProperty(APP_CONFIG_KEYS_.HMAC_DIAGNOSTIC_ENABLED, 'true');
  return { enabled: true };
}

function testIdentifierHashSecretSeparation() {
  var rawIdentifier = 'LINE使用者-U繁體中文';
  var identifierSecret = '永久識別金鑰-測試';
  var firstBindSecret = 'bind-secret-version-1';
  var secondBindSecret = 'bind-secret-version-2';
  var firstIdentifierHash = hmacHex_(identifierSecret, rawIdentifier);
  var secondIdentifierHash = hmacHex_(identifierSecret, rawIdentifier);
  assertTest_(firstIdentifierHash === secondIdentifierHash, '輪替 Bind Token Secret 不得改變識別雜湊。');
  assertTest_(
    hmacHex_(firstBindSecret, 'bind-payload') !== hmacHex_(secondBindSecret, 'bind-payload'),
    '不同 Bind Token Secret 應產生不同 Token 簽章。'
  );
  assertTest_(
    firstIdentifierHash !== hmacHex_('different-identifier-secret', rawIdentifier),
    '只有輪替 IDENTIFIER_HASH_SECRET 才會改變識別雜湊。'
  );
  assertTest_(
    firstIdentifierHash === '7ec777e9164c89d93d0f6e67e2c22f76a1750cd75ee3b76611163dba8cd67cb6',
    'GAS UTF-8 HMAC-SHA256 必須符合跨平台固定向量。'
  );
  console.log('永久識別雜湊金鑰分離與 UTF-8 固定向量測試通過。');
}

function testNonceValidation() {
  ensureAdminSheets_();
  var nonce = Utilities.getUuid().replace(/-/g, '').toLowerCase();
  consumeNonce_(nonce, 'MANUAL_TEST', new Date(Date.now() + 60000));
  var replayRejected = false;
  try {
    consumeNonce_(nonce, 'MANUAL_TEST', new Date(Date.now() + 60000));
  } catch (error) {
    replayRejected = isAppError_(error) && error.appCode === 'NONCE_REPLAYED';
  }
  assertTest_(replayRejected, '相同 Nonce 必須只能使用一次。');
  console.log('Nonce 驗證測試通過。');
}

function testFileNameSanitization() {
  var sanitized = sanitizeFileName_('../危險\\名稱\u0000?.pdf', 'fallback.bin');
  assertTest_(sanitized.indexOf('/') < 0 && sanitized.indexOf('\\') < 0, '檔名不可包含路徑符號。');
  assertTest_(sanitized.indexOf('..') < 0, '檔名不可包含路徑穿越片段。');
  console.log('檔名清理測試通過：' + sanitized);
}

function testTagExtraction() {
  var tags = extractTags_('#筆記 #台北 #旅遊 #旅遊');
  assertTest_(JSON.stringify(tags) === JSON.stringify(['台北', '旅遊']), '標籤應去重且排除「筆記」。');
  console.log('標籤解析測試通過。');
}

function testUrlExtraction() {
  var urls = extractUrls_('請看 https://example.com/a，或 http://example.org。');
  assertTest_(urls.length === 2, '應擷取 2 個網址。');
  assertTest_(urls[0] === 'https://example.com/a', '網址不應包含中文句尾標點。');
  console.log('網址解析測試通過。');
}

function testInitializeAdminSpreadsheet() {
  ensureAdminSheets_();
  assertTest_(getAdminSpreadsheet_().getSheets().length >= 7, '管理試算表應至少有 7 個工作表。');
  console.log('管理試算表初始化測試通過。');
}

function getManualTestUser_() {
  var lineUserHash = PropertiesService.getScriptProperties().getProperty('TEST_LINE_USER_HASH');
  if (!lineUserHash || !/^[a-f0-9]{64}$/.test(lineUserHash)) {
    throw new Error('請先在 Script Properties 設定 TEST_LINE_USER_HASH，值取自 Users 工作表的 LineUserHash。');
  }
  return { lineUserHash: lineUserHash, accessToken: getUserAccessToken_(lineUserHash) };
}

function testCreateUserDriveRootFolder() {
  var testUser = getManualTestUser_();
  var folderId = createDriveFolder_(testUser.accessToken, 'LINE 備份手動測試_' + Date.now(), null);
  assertTest_(typeof folderId === 'string' && folderId.length > 5, '應建立測試根資料夾。');
  console.log('測試資料夾已建立，請依名稱確認並在測試後自行刪除。');
}

function testCreatePersonalBackupSheet() {
  var testUser = getManualTestUser_();
  var rootFolderId = createDriveFolder_(testUser.accessToken, 'LINE Sheet 手動測試_' + Date.now(), null);
  var sheetId = createBackupSpreadsheet_(testUser.accessToken, rootFolderId);
  assertTest_(typeof sheetId === 'string' && sheetId.length > 5, '應建立個人備份 Sheet。');
  console.log('測試 Sheet 已建立，請依名稱確認並在測試後自行刪除。');
}

function testWebhookEventDeduplication() {
  ensureAdminSheets_();
  var eventId = 'manual-test-' + Date.now();
  var job = { webhookEventId: eventId, messageId: 'manual-message-' + Date.now() };
  var first = claimJob_(job);
  var second = claimJob_(job);
  assertTest_(first.claimed === true, '第一次工作應取得處理權。');
  assertTest_(second.claimed === false, '相同 webhookEventId 不可再次取得處理權。');
  completeJob_(eventId, '');
  console.log('Webhook 去重測試通過。');
}

function appendManualJobForLeaseTest_(eventId, status, leaseExpiresAt, driveFileId) {
  var now = getTaipeiNow_();
  appendAdminRow_('Jobs', [
    eventId,
    'manual-message-' + Date.now(),
    status,
    0,
    leaseExpiresAt || '',
    driveFileId || '',
    '',
    '',
    now,
    now
  ]);
}

function createManualSignedWorkerRequest_(job) {
  var timestamp = Date.now();
  var nonce = Utilities.getUuid().replace(/-/g, '').toLowerCase();
  var payload = JSON.stringify(job);
  return {
    postData: {
      contents: JSON.stringify({
        timestamp: timestamp,
        nonce: nonce,
        payload: payload,
        signature: hmacHex_(
          getRequiredProperty_(APP_CONFIG_KEYS_.WORKER_GAS_SHARED_SECRET),
          timestamp + '.' + nonce + '.' + payload
        )
      })
    }
  };
}

function createManualLeaseQueueJob_(eventId) {
  return {
    schemaVersion: 1,
    eventType: 'message',
    webhookEventId: eventId,
    messageId: 'manual-message-' + Date.now(),
    messageType: 'text',
    lineUserHash: 'a'.repeat(64),
    groupIdHash: null,
    senderDisplayName: 'manual-user',
    groupDisplayName: null,
    replyToken: null,
    timestamp: Date.now(),
    fileName: null,
    fileSize: null,
    rawText: '手動租約測試',
    command: null,
    shouldSave: true,
    rejectionCode: null,
    bindToken: null
  };
}

function testJobRetryAfterSecondsBoundaries() {
  var now = Date.now();
  assertTest_(
    getJobRetryAfterSeconds_(new Date(now + 60000), now) === 65,
    '剩餘 60 秒租約應加上 5 秒安全緩衝。'
  );
  assertTest_(
    getJobRetryAfterSeconds_(new Date(now + 1000), now) === 30,
    'retryAfterSeconds 不可小於 30 秒。'
  );
  assertTest_(
    getJobRetryAfterSeconds_(new Date(now + 3600000), now) === 900,
    'retryAfterSeconds 不可大於 900 秒。'
  );
  console.log('工作租約 retryAfterSeconds 計算與邊界測試通過。');
}

function testActiveProcessingLeaseCannotBeReclaimed() {
  ensureAdminSheets_();
  var eventId = 'manual-active-lease-' + Date.now();
  appendManualJobForLeaseTest_(eventId, 'PROCESSING', new Date(Date.now() + 60000), '');
  var claim = claimJob_({ webhookEventId: eventId, messageId: 'manual-active' });
  assertTest_(claim.claimed === false, '未過期 PROCESSING 租約不可重新取得。');
  assertTest_(claim.status === 'PROCESSING', '有效租約應回傳 PROCESSING 狀態。');
  assertTest_(claim.leaseExpiresAt instanceof Date, '有效租約應回傳 LeaseExpiresAt。');
  assertTest_(
    Number.isSafeInteger(claim.retryAfterSeconds) &&
      claim.retryAfterSeconds >= 30 &&
      claim.retryAfterSeconds <= 900,
    '有效租約應回傳安全範圍內的 retryAfterSeconds。'
  );
  completeJob_(eventId, '');
  console.log('未過期 PROCESSING 租約測試通過。');
}

function testJobInProgressDoesNotWriteError() {
  ensureAdminSheets_();
  var eventId = 'manual-job-in-progress-' + Date.now();
  appendManualJobForLeaseTest_(eventId, 'PROCESSING', new Date(Date.now() + 60000), '');
  var errorSheet = getAdminSheet_('Errors');
  var errorsBefore = errorSheet.getLastRow();
  var result = JSON.parse(
    doPost(createManualSignedWorkerRequest_(createManualLeaseQueueJob_(eventId))).getContent()
  );
  assertTest_(result.ok === false, '租約內 PROCESSING 不可回傳成功。');
  assertTest_(result.retryable === true, '租約內 PROCESSING 必須要求 Queue 重試。');
  assertTest_(result.errorCode === 'JOB_IN_PROGRESS', '應回傳 JOB_IN_PROGRESS。');
  assertTest_(
    Number.isSafeInteger(result.retryAfterSeconds) &&
      result.retryAfterSeconds >= 30 &&
      result.retryAfterSeconds <= 900,
    '應回傳安全範圍內的重試延遲。'
  );
  assertTest_(errorSheet.getLastRow() === errorsBefore, 'JOB_IN_PROGRESS 不得寫入 Errors。');
  assertTest_(findJobByWebhookId_(eventId).Status === 'PROCESSING', '工作不可被改成 FAILED。');
  completeJob_(eventId, '');
  console.log('JOB_IN_PROGRESS 安全協調與 Errors 保護測試通過。');
}

function testCompletedJobAcknowledgesAfterInProgressRetry() {
  ensureAdminSheets_();
  var eventId = 'manual-completed-after-retry-' + Date.now();
  var job = createManualLeaseQueueJob_(eventId);
  appendManualJobForLeaseTest_(eventId, 'PROCESSING', new Date(Date.now() + 60000), '');
  var firstResult = JSON.parse(doPost(createManualSignedWorkerRequest_(job)).getContent());
  assertTest_(firstResult.errorCode === 'JOB_IN_PROGRESS', '第一次應要求延後重試。');
  completeJob_(eventId, '');
  var secondResult = JSON.parse(doPost(createManualSignedWorkerRequest_(job)).getContent());
  assertTest_(secondResult.ok === true, '原程序完成後，後續重試應辨識 COMPLETED。');
  assertTest_(findJobByWebhookId_(eventId).Status === 'COMPLETED', '終態不得被重做或改寫。');
  console.log('PROCESSING 延後後辨識 COMPLETED 測試通過。');
}

function testExpiredProcessingLeaseCanBeReclaimed() {
  ensureAdminSheets_();
  var eventId = 'manual-expired-lease-' + Date.now();
  appendManualJobForLeaseTest_(eventId, 'PROCESSING', new Date(Date.now() - 60000), '');
  var claim = claimJob_({ webhookEventId: eventId, messageId: 'manual-expired' });
  assertTest_(claim.claimed === true, '過期 PROCESSING 租約應可重新取得。');
  assertTest_(Number(findJobByWebhookId_(eventId).RetryCount) === 1, '重新取得應增加 RetryCount。');
  completeJob_(eventId, '');
  console.log('過期 PROCESSING 租約重新取得測試通過。');
}

function testExpiredLeaseReclaimPreservesDriveFileId() {
  ensureAdminSheets_();
  var eventId = 'manual-expired-file-lease-' + Date.now();
  var driveFileId = 'manual-drive-file-' + Date.now();
  appendManualJobForLeaseTest_(eventId, 'PROCESSING', new Date(Date.now() - 60000), driveFileId);
  assertTest_(
    claimJob_({ webhookEventId: eventId, messageId: 'manual-expired-file' }).claimed === true,
    '過期 PROCESSING 租約應可重新取得。'
  );
  assertTest_(
    findJobByWebhookId_(eventId).DriveFileId === driveFileId,
    '過期租約重新取得時必須保留 DriveFileId。'
  );
  completeJob_(eventId, driveFileId);
  console.log('過期租約保留 DriveFileId 測試通過。');
}

function testCompletedJobCannotBeReclaimed() {
  ensureAdminSheets_();
  var eventId = 'manual-completed-lease-' + Date.now();
  appendManualJobForLeaseTest_(eventId, 'COMPLETED', '', 'manual-completed-file');
  var claim = claimJob_({ webhookEventId: eventId, messageId: 'manual-completed' });
  assertTest_(claim.claimed === false, 'COMPLETED 工作不可重新取得。');
  console.log('COMPLETED 工作不可重新取得測試通過。');
}

function testDriveEventIdempotencyKey() {
  var first = createDriveEventKey_('manual-event-same');
  var second = createDriveEventKey_('manual-event-same');
  var different = createDriveEventKey_('manual-event-different');
  assertTest_(first === second, '同一 webhookEventId 必須產生相同冪等鍵。');
  assertTest_(first !== different, '不同 webhookEventId 必須產生不同冪等鍵。');
  assertTest_(/^[a-f0-9]{64}$/.test(first), 'Drive 冪等鍵必須是 64 位 HMAC-SHA256。');
  console.log('Drive appProperties 冪等鍵測試通過。');
}

function testBuildDriveAppPropertiesQuery() {
  var propertyName = 'lineBackupResourceKey';
  var propertyValue = 'value\'with\\slash';
  var query = buildDriveAppPropertiesQuery_(
    propertyName,
    propertyValue,
    'parent-folder-id',
    'application/vnd.google-apps.folder'
  );
  assertTest_(query.indexOf("appProperties has { key='lineBackupResourceKey'") === 0, 'Drive appProperties 查詢格式不正確。');
  assertTest_(query.indexOf("value='" + escapeDriveQuery_(propertyValue) + "'") >= 0, 'appProperties value 必須正確跳脫。');
  assertTest_(query.indexOf('trashed=false') >= 0, 'Drive 查詢必須排除垃圾桶檔案。');
  assertTest_(query.indexOf("mimeType='application/vnd.google-apps.folder'") >= 0, '資料夾查詢必須限制 mimeType。');
  console.log('Drive appProperties 查詢格式測試通過。');
}

function testDriveFilesListUrlEncoding() {
  var query = buildDriveAppPropertiesQuery_(
    'lineBackupResourceKey',
    'a'.repeat(64),
    'parent-folder-id',
    'application/vnd.google-apps.folder'
  );
  var url = buildDriveFilesListUrl_(query);
  assertTest_(url.indexOf('q=' + encodeURIComponent(query)) >= 0, 'Drive q 必須使用 URL encode。');
  assertTest_(url.indexOf('fields=' + encodeURIComponent('files(id,name,mimeType,appProperties,webViewLink)')) >= 0, 'Drive fields 必須使用 URL encode。');
  console.log('Drive files.list URL 編碼測試通過。');
}

function testDriveFilesListEmptyResultIsNotError() {
  assertTest_(getDriveItemFromListResult_({ files: [] }) === null, 'Drive files.list 空結果應視為不存在並回傳 null。');
  assertTest_(getDriveItemFromListResult_({}) === null, 'Drive files.list 缺少 files 時應安全視為空結果。');
  console.log('Drive files.list 空結果測試通過。');
}

function testDriveApiErrorDiagnostics() {
  var response = {
    getResponseCode: function () { return 400; },
    getContentText: function () {
      return JSON.stringify({
        error: {
          code: 400,
          message: "Invalid query: appProperties has value='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
          errors: [{ reason: 'invalidQuery', domain: 'global', message: 'Invalid query' }]
        }
      });
    }
  };
  var error = createDriveApiError_(response, 'DRIVE_IDEMPOTENCY_SEARCH_FAILED');
  assertTest_(error.appCode === 'DRIVE_IDEMPOTENCY_SEARCH_FAILED', 'Drive 400 應保留安全錯誤碼。');
  assertTest_(error.httpStatus === 400, 'Drive 錯誤應記錄 HTTP status。');
  assertTest_(error.googleReason === 'invalidQuery', 'Drive 錯誤應記錄安全 reason。');
  assertTest_(error.googleDomain === 'global', 'Drive 錯誤應記錄安全 domain。');
  assertTest_(error.googleMessageSummary === 'Google Drive 查詢錯誤。', 'Drive 查詢錯誤摘要不得包含完整 query。');
  var safeText = JSON.stringify(error);
  assertTest_(safeText.indexOf('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') < 0, 'Drive 錯誤不得包含完整 appProperties value。');
  console.log('Drive API 400 安全診斷測試通過。');
}

function testFailedBindingSessionCanResume() {
  ensureAdminSheets_();
  var lineUserHash = '9'.repeat(64);
  var bindNonce = Utilities.getUuid().replace(/-/g, '').toLowerCase();
  var expiresAt = Date.now() + 60000;
  appendAdminRow_('BindingSessions', [
    getBindingSessionNonceHash_(bindNonce),
    lineUserHash,
    '8'.repeat(64),
    new Date(expiresAt),
    '',
    'FAILED',
    getTaipeiNow_(),
    getTaipeiNow_(),
    'DRIVE_IDEMPOTENCY_SEARCH_FAILED'
  ]);
  var recoverable = findRecoverableBindingSessionByUserHash_(lineUserHash);
  assertTest_(recoverable && recoverable.Status === 'FAILED', 'FAILED BindingSession 應可被恢復流程找到。');
  var provisioning = beginBindingSessionProvisioning_(lineUserHash, recoverable.SessionNonceHash);
  assertTest_(provisioning.Status === 'PROVISIONING', 'FAILED BindingSession 應可再次進入 PROVISIONING。');
  markBindingSessionFailed_(lineUserHash, provisioning.SessionNonceHash, 'MANUAL_RESUME_CHECK');
  console.log('FAILED BindingSession 可恢復測試通過。');
}

function testFailedJobPreservesDriveFileId() {
  ensureAdminSheets_();
  var eventId = 'manual-failed-job-' + Date.now();
  var driveFileId = 'manual-drive-file-id-' + Date.now();
  var job = { webhookEventId: eventId, messageId: 'manual-message-' + Date.now() };
  assertTest_(claimJob_(job).claimed === true, '測試工作第一次應取得處理權。');
  recordJobDriveFile_(eventId, driveFileId);
  failJob_(eventId, 'MANUAL_FAILURE', '模擬 Sheet 寫入失敗。');
  var failedJob = findJobByWebhookId_(eventId);
  assertTest_(failedJob.Status === 'FAILED', '工作應標示為 FAILED。');
  assertTest_(failedJob.DriveFileId === driveFileId, 'FAILED 必須保留 DriveFileId。');
  assertTest_(claimJob_(job).claimed === true, 'FAILED 工作應允許 Queue 重試。');
  var retriedJob = findJobByWebhookId_(eventId);
  assertTest_(retriedJob.DriveFileId === driveFileId, '重試時必須沿用原 DriveFileId。');
  completeJob_(eventId, driveFileId);
  console.log('FAILED 工作保留 DriveFileId 測試通過。');
}

function testBindingSessionCanBeReopenedBeforeCallback() {
  ensureAdminSheets_();
  var lineUserHash = 'a'.repeat(64);
  var bindNonce = Utilities.getUuid().replace(/-/g, '').toLowerCase();
  var expiresAt = Date.now() + 60000;
  appendAdminRow_('BindingSessions', [
    getBindingSessionNonceHash_(bindNonce),
    lineUserHash,
    'b'.repeat(64),
    new Date(expiresAt),
    '',
    'PENDING',
    getTaipeiNow_(),
    getTaipeiNow_(),
    ''
  ]);
  assertTest_(assertPendingBindingSession_(lineUserHash, bindNonce, expiresAt).Status === 'PENDING', '第一次驗證應成功。');
  assertTest_(assertPendingBindingSession_(lineUserHash, bindNonce, expiresAt).Status === 'PENDING', '頁面重新整理的第二次驗證仍應成功。');
  console.log('OAuth callback 前重複開啟綁定頁測試通過。');
}

function testCompletedBindingSessionRejectsReplay() {
  ensureAdminSheets_();
  var lineUserHash = 'c'.repeat(64);
  var bindNonce = Utilities.getUuid().replace(/-/g, '').toLowerCase();
  var expiresAt = Date.now() + 60000;
  appendAdminRow_('BindingSessions', [
    getBindingSessionNonceHash_(bindNonce),
    lineUserHash,
    'd'.repeat(64),
    new Date(expiresAt),
    getTaipeiNow_(),
    'COMPLETED',
    getTaipeiNow_(),
    getTaipeiNow_(),
    ''
  ]);
  var replayRejected = false;
  try {
    assertPendingBindingSession_(lineUserHash, bindNonce, expiresAt);
  } catch (error) {
    replayRejected = isAppError_(error) && error.appCode === 'BIND_SESSION_INVALID';
  }
  assertTest_(replayRejected, '完成後的相同 BindingSession 必須拒絕重播。');
  console.log('BindingSession 重播拒絕測試通過。');
}

function testBindingSessionInvitationConsumption() {
  ensureAdminSheets_();
  var suffix = String(Date.now());
  var inviteCode = 'TEST-' + suffix;
  var lineUserHash = 'e'.repeat(64);
  var bindNonce = Utilities.getUuid().replace(/-/g, '').toLowerCase();
  var expiresAt = Date.now() + 60000;
  createInvitationForAdmin_(inviteCode, 1, new Date(expiresAt));
  createBindingSession_(lineUserHash, bindNonce, expiresAt, inviteCode);
  var inviteCodeHash = hashIdentifier_('INVITE:' + inviteCode);
  assertTest_(Number(findInvitationByHash_(inviteCodeHash).UsedCount) === 0, '建立待綁定工作階段不可扣除邀請次數。');
  var authorizedSession = markBindingSessionAuthorized_(lineUserHash, bindNonce, expiresAt);
  assertTest_(Number(findInvitationByHash_(inviteCodeHash).UsedCount) === 0, 'AUTHORIZED 只保留名額，不可先扣除邀請次數。');
  var provisioningSession = beginBindingSessionProvisioning_(lineUserHash, authorizedSession.SessionNonceHash);
  completeBindingSession_(lineUserHash, provisioningSession.SessionNonceHash, {
    lineUserHash: lineUserHash,
    googleSubjectId: 'manual-google-subject-' + suffix,
    googleEmail: 'manual-' + suffix + '@example.invalid',
    rootFolderId: 'manual-root-' + suffix,
    personalFolderId: 'manual-personal-' + suffix,
    groupFolderId: 'manual-group-' + suffix,
    sheetId: 'manual-sheet-' + suffix
  });
  assertTest_(Number(findInvitationByHash_(inviteCodeHash).UsedCount) === 1, '完成 OAuth 後應扣除 1 次邀請。');
  var replayRejected = false;
  try {
    completeBindingSession_(lineUserHash, provisioningSession.SessionNonceHash, {
      lineUserHash: lineUserHash,
      googleSubjectId: 'manual-google-subject-' + suffix,
      googleEmail: 'manual-' + suffix + '@example.invalid',
      rootFolderId: 'manual-root-' + suffix,
      personalFolderId: 'manual-personal-' + suffix,
      groupFolderId: 'manual-group-' + suffix,
      sheetId: 'manual-sheet-' + suffix
    });
  } catch (error) {
    replayRejected = isAppError_(error) && error.appCode === 'BIND_SESSION_NOT_PROVISIONING';
  }
  assertTest_(replayRejected, '完成後重送 callback 必須遭拒絕。');
  assertTest_(Number(findInvitationByHash_(inviteCodeHash).UsedCount) === 1, 'callback 重送不得重複扣除邀請次數。');
  console.log('BindingSession 邀請次數與重播測試通過。');
}

function testAuthorizedBindingFailureIsRecoverable() {
  ensureAdminSheets_();
  var suffix = String(Date.now());
  var inviteCode = 'RECOVER-' + suffix;
  var lineUserHash = 'f'.repeat(64);
  var bindNonce = Utilities.getUuid().replace(/-/g, '').toLowerCase();
  var expiresAt = Date.now() + 60000;
  createInvitationForAdmin_(inviteCode, 1, new Date(expiresAt));
  createBindingSession_(lineUserHash, bindNonce, expiresAt, inviteCode);
  var authorized = markBindingSessionAuthorized_(lineUserHash, bindNonce, expiresAt);
  var provisioning = beginBindingSessionProvisioning_(lineUserHash, authorized.SessionNonceHash);
  markBindingSessionFailed_(lineUserHash, provisioning.SessionNonceHash, 'MANUAL_PROVISIONING_FAILURE');
  var recoverable = findRecoverableBindingSessionByUserHash_(lineUserHash);
  assertTest_(recoverable && recoverable.Status === 'FAILED', '初始化失敗後 Session 應可恢復。');
  var invitation = findInvitationByHash_(hashIdentifier_('INVITE:' + inviteCode));
  assertTest_(Number(invitation.UsedCount) === 0, '初始化失敗不可扣除邀請次數。');
  var retried = beginBindingSessionProvisioning_(lineUserHash, recoverable.SessionNonceHash);
  assertTest_(retried.Status === 'PROVISIONING', 'FAILED Session 應可重新進入 PROVISIONING。');
  markBindingSessionFailed_(lineUserHash, retried.SessionNonceHash, 'MANUAL_RETRY_STOP');
  assertTest_(Number(findInvitationByHash_(invitation.InviteCodeHash).UsedCount) === 0, '恢復重試不可再次消耗邀請碼。');
  console.log('AUTHORIZED 初始化失敗與恢復測試通過。');
}

function testRecoveryLineUserHashValidation() {
  assertTest_(assertRecoveryLineUserHash_('a'.repeat(64)) === 'a'.repeat(64), '64 碼雜湊應通過恢復檢查。');
  var invalidErrorCode = '';
  try {
    assertRecoveryLineUserHash_('not-a-line-user-hash');
  } catch (error) {
    invalidErrorCode = error && error.appCode;
  }
  assertTest_(invalidErrorCode === 'BIND_RECOVERY_USER_INVALID', '無效恢復雜湊應遭拒絕。');
  console.log('OAuth Token 恢復雜湊安全檢查通過。');
}

function testGoogleUserOAuthScopes() {
  var scopeString = getGoogleUserOAuthScopeString_();
  var scopes = scopeString.split(/\s+/);
  assertTest_(scopes.indexOf('openid') >= 0, '使用者 OAuth 必須包含 openid。');
  assertTest_(scopes.indexOf('email') >= 0, '使用者 OAuth 必須包含 email。');
  assertTest_(scopes.indexOf('profile') >= 0, '使用者 OAuth 必須包含 profile。');
  assertTest_(scopes.indexOf('https://www.googleapis.com/auth/drive.file') >= 0, '使用者 OAuth 必須包含 drive.file。');
  assertTest_(scopes.indexOf('https://www.googleapis.com/auth/script.external_request') < 0, '使用者 OAuth 不得包含 script.external_request。');
  assertTest_(scopes.indexOf('https://www.googleapis.com/auth/spreadsheets') < 0, '使用者 OAuth 不得只使用 spreadsheets。');
  var params = getGoogleOAuthAuthorizationParams_({ stateMarker: 'manual-test' });
  assertTest_(params.access_type === 'offline', '授權 URL 必須要求 offline。');
  assertTest_(params.prompt === 'consent', '授權 URL 必須要求 consent。');
  assertTest_(params.stateMarker === 'manual-test', 'OAuth state 額外參數不可遺失。');
  console.log('使用者 Google OAuth scope 與授權參數測試通過。');
}

function testSelfServiceApprovalHelpers() {
  var pendingHash = 'a'.repeat(64);
  var pendingUser = {
    LineUserHash: pendingHash,
    GoogleSubjectId: 'self-service-subject',
    Enabled: false,
    ApprovalStatus: USER_APPROVAL_STATUS_.PENDING
  };
  assertTest_(getUserReviewCode_(pendingHash) === 'UAAAAAAAA', '待審核代號應為安全化短代號。');
  assertTest_(!isApprovedEnabledUser_(pendingUser), '未核准使用者不可視為可備份。');
  var properties = PropertiesService.getScriptProperties();
  var previousApprovalSetting = properties.getProperty(APP_CONFIG_KEYS_.REQUIRE_ADMIN_APPROVAL);
  try {
    properties.setProperty(APP_CONFIG_KEYS_.REQUIRE_ADMIN_APPROVAL, 'true');
    assertTest_(
      determineBindingApprovalStatus_({ InviteCodeHash: '' }, null) === USER_APPROVAL_STATUS_.PENDING,
      'REQUIRE_ADMIN_APPROVAL=true 時自助綁定應進入 PENDING_APPROVAL。'
    );
    properties.setProperty(APP_CONFIG_KEYS_.REQUIRE_ADMIN_APPROVAL, 'false');
    assertTest_(
      determineBindingApprovalStatus_({ InviteCodeHash: '' }, null) === USER_APPROVAL_STATUS_.APPROVED,
      'REQUIRE_ADMIN_APPROVAL=false 時自助綁定應自動 APPROVED。'
    );
  } finally {
    if (previousApprovalSetting === null) {
      properties.deleteProperty(APP_CONFIG_KEYS_.REQUIRE_ADMIN_APPROVAL);
    } else {
      properties.setProperty(APP_CONFIG_KEYS_.REQUIRE_ADMIN_APPROVAL, previousApprovalSetting);
    }
  }
  assertTest_(
    determineBindingApprovalStatus_({ InviteCodeHash: 'invite-hash' }, pendingUser) === USER_APPROVAL_STATUS_.APPROVED,
    '既有邀請碼流程應維持核准。'
  );
  assertTest_(
    determineBindingApprovalStatus_({ InviteCodeHash: '' }, {
      GoogleSubjectId: 'existing-subject',
      Enabled: true,
      ApprovalStatus: USER_APPROVAL_STATUS_.APPROVED
    }) === USER_APPROVAL_STATUS_.APPROVED,
    '既有已綁定使用者不可被自助流程改成待審核。'
  );
  Logger.log('PASS testSelfServiceApprovalHelpers：自助綁定自動核准／管理者審核分流。');
}

function testRoleBasedHelpMessages() {
  var properties = PropertiesService.getScriptProperties();
  var previousAdmins = properties.getProperty(APP_CONFIG_KEYS_.ADMIN_LINE_USER_HASHES);
  var adminRawIdentifier = 'manual-help-admin';
  var regularRawIdentifier = 'manual-help-user';
  var adminHash = hashIdentifier_(adminRawIdentifier);
  try {
    properties.setProperty(APP_CONFIG_KEYS_.ADMIN_LINE_USER_HASHES, adminHash);
    var regularHelp = getHelpMessage_({ lineUserHash: hashIdentifier_(regularRawIdentifier), groupIdHash: null });
    var adminHelp = getHelpMessage_({ lineUserHash: adminHash, groupIdHash: null });
    var groupHelp = getHelpMessage_({ lineUserHash: hashIdentifier_(regularRawIdentifier), groupIdHash: 'a'.repeat(64) });
    assertTest_(regularHelp.indexOf('待審核') < 0, '一般使用者說明不得顯示管理者指令。');
    ['綁定', '狀態', '解除綁定', '紀錄', '查詢紀錄', '容量', '空間', 'Drive容量', '#筆記', '20 MB 以下'].forEach(function (keyword) {
      assertTest_(regularHelp.indexOf(keyword) >= 0, '一般使用者說明缺少：' + keyword);
    });
    ['待審核', '核准 <編號[,編號]>', '拒絕 <編號[,編號]>', '核准全部', '拒絕全部', '確認核准全部', '確認拒絕全部']
      .forEach(function (keyword) {
        assertTest_(adminHelp.indexOf(keyword) >= 0, '管理者說明缺少：' + keyword);
      });
    assertTest_(adminHelp.indexOf('【管理者指令】（僅管理者可見）') >= 0, '管理者說明應標示管理者專區。');
    ['#筆記', '狀態', '綁定群組', '解除群組', '容量資訊屬於個人 Google Drive', '群組附件備份規則', '群組附件成功預設不回覆', '群組 #筆記 成功會回覆', '個人綁定、紀錄查詢、容量查詢與管理者審核指令請私訊 Bot 執行。']
      .forEach(function (keyword) {
        assertTest_(groupHelp.indexOf(keyword) >= 0, '群組說明缺少：' + keyword);
      });
    assertTest_(groupHelp.indexOf('待審核') < 0, '群組說明不得顯示管理者指令。');
    assertTest_(groupHelp.indexOf('route=bind') < 0 && groupHelp.indexOf('route=query') < 0 && groupHelp.indexOf('http') < 0, '群組說明不得顯示 OAuth 或查詢連結。');
    [adminRawIdentifier, regularRawIdentifier, 'user@example.com', 'Access Token', 'Refresh Token', 'Secret']
      .forEach(function (sensitiveValue) {
        assertTest_(regularHelp.indexOf(sensitiveValue) < 0 && adminHelp.indexOf(sensitiveValue) < 0 && groupHelp.indexOf(sensitiveValue) < 0, '說明不得包含敏感資料：' + sensitiveValue);
      });
  } finally {
    if (previousAdmins === null) {
      properties.deleteProperty(APP_CONFIG_KEYS_.ADMIN_LINE_USER_HASHES);
    } else {
      properties.setProperty(APP_CONFIG_KEYS_.ADMIN_LINE_USER_HASHES, previousAdmins);
    }
  }
  Logger.log('PASS testRoleBasedHelpMessages：一般使用者、管理者與群組說明分流。');
}

function testRecordQueryTokenHelpers() {
  var lineUserHash = 'a'.repeat(64);
  var nonce = '0123456789abcdef0123456789abcdef';
  var now = Date.now();
  var token = createRecordQueryToken_(lineUserHash, now + 600000, nonce, 'TEST_QUERY_SECRET');
  var payload = decodeRecordQueryPayload_(token.split('.')[0]);
  assertTest_(isRecordQueryPayloadValid_(payload, now), '未過期查詢 Token 應可通過格式驗證。');
  assertTest_(token.indexOf(lineUserHash) < 0, '查詢 Token 不得直接包含識別雜湊以外的原始識別。');
  assertTest_(!isRecordQueryPayloadValid_(
    decodeRecordQueryPayload_(createRecordQueryToken_(lineUserHash, now - 1, nonce, 'TEST_QUERY_SECRET').split('.')[0]),
    now
  ), '過期查詢 Token 不可使用。');
  var otherUserPayload = Object.assign({}, payload, { lineUserHash: 'b'.repeat(64) });
  assertTest_(otherUserPayload.lineUserHash !== payload.lineUserHash, '查詢 Token 必須綁定單一使用者。');
  Logger.log('PASS testRecordQueryTokenHelpers：查詢 Token 期限、雜湊與使用者綁定。');
}

function testRecordQueryDisplaySafety() {
  var row = {
    'LINE 訊息時間': '2026-08-08 12:00:00',
    '來源類型': '群組',
    '群組名稱': '測試群組',
    '傳送者識別': 'sender-hash',
    '傳送者名稱': 'U0123456789abcdef0123456789abcdef user@example.com',
    '訊息類型': 'text',
    '原始檔名': '',
    '文字內容': '訊息內容 0123456789abcdef0123456789abcdef',
    '錯誤訊息': '',
    'Drive 連結': ''
  };
  var mapped = mapRecordQueryRow_(row);
  var serialized = JSON.stringify(mapped);
  assertTest_(serialized.indexOf('U0123456789abcdef0123456789abcdef') < 0, '查詢結果不得顯示 LINE userId。');
  assertTest_(serialized.indexOf('user@example.com') < 0, '查詢結果不得顯示 Google Email 原文。');
  assertTest_(serialized.indexOf('0123456789abcdef0123456789abcdef') < 0, '查詢結果不得顯示完整識別雜湊。');
  assertTest_(mapped.senderName.indexOf('已隱藏') >= 0, '查詢結果應顯示安全化傳送者名稱。');
  assertTest_(matchesRecordQueryFilters_(row, normalizeRecordQueryFilters_({ keyword: '測試群組' })), '群組名稱應可搜尋。');
  assertTest_(matchesRecordQueryFilters_(row, normalizeRecordQueryFilters_({ keyword: '訊息內容' })), '文字內容應可搜尋。');
  Logger.log('PASS testRecordQueryDisplaySafety：查詢結果敏感欄位遮罩。');
}

function testRecordQueryShortCodeHelpers() {
  var lineUserHash = 'a'.repeat(64);
  var groupHash = 'b'.repeat(64);
  var shortCode = createRecordQueryShortCode_();
  assertTest_(isRecordQueryShortCode_(shortCode), '短碼必須是 8～12 碼 URL safe 字串。');
  assertTest_(shortCode.length === 10, '短碼預設長度應為 10 碼。');
  assertTest_(shortCode.indexOf(lineUserHash) < 0 && shortCode.indexOf(groupHash) < 0, '短碼不可包含識別雜湊。');
  var shortHash = hashRecordQueryShortCode_(shortCode);
  assertTest_(/^[a-f0-9]{64}$/.test(shortHash), '短碼只應以 HMAC 雜湊保存。');
  var shortUrl = buildRecordQueryShortUrl_('https://example.invalid/exec', shortCode);
  assertTest_(/\/exec\?route=q&id=[A-Za-z0-9_-]{8,12}$/.test(shortUrl), '查詢網址應只帶 route=q 與短碼。');
  assertTest_(shortUrl.indexOf(lineUserHash) < 0 && shortUrl.indexOf(groupHash) < 0, '查詢網址不得包含使用者或群組雜湊。');
  var record = {
    lineUserHash: lineUserHash,
    groupIdHash: groupHash,
    startDate: '2026-08-01',
    endDate: '2026-08-31',
    expiresAt: Date.now() + 600000,
    nonce: '0123456789abcdef0123456789abcdef',
    scope: 'group-record-query'
  };
  var serialized = JSON.stringify(record);
  assertTest_(serialized.indexOf(shortCode) < 0, '儲存資料不應保存完整短碼。');
  assertTest_(getRecordQueryShortPropertyKey_(shortHash).indexOf(shortCode) < 0, 'Property key 不應包含完整短碼。');
  Logger.log('PASS testRecordQueryShortCodeHelpers：短碼格式、雜湊儲存與不可逆內容。');
}

function testLegacyGroupRecordSafetyHelpers() {
  var ownerHash = 'a'.repeat(64);
  var group = { OwnerLineUserHash: ownerHash, GroupName: '唯一群組', GroupIdHash: 'b'.repeat(64), Enabled: true };
  var uniqueMap = getUniqueLegacyGroupMap_([group]);
  assertTest_(uniqueMap[ownerHash + '\n唯一群組'].GroupIdHash === group.GroupIdHash, '唯一群組名稱應可建立安全對應。');
  var duplicate = Object.assign({}, group, { GroupIdHash: 'c'.repeat(64) });
  var duplicateMap = getUniqueLegacyGroupMap_([group, duplicate]);
  assertTest_(duplicateMap[ownerHash + '\n唯一群組'] === null, '同 owner 同名群組不得 fallback。');
  assertTest_(isLegacyGroupRecordForGroup_({
    '來源類型': '群組',
    '群組識別': '',
    '群組名稱': '唯一群組'
  }, group), '舊群組紀錄需符合來源、空識別與名稱。');
  assertTest_(!isLegacyGroupRecordForGroup_({
    '來源類型': '個人',
    '群組識別': '',
    '群組名稱': '唯一群組'
  }, group), '個人紀錄不可 fallback 成群組紀錄。');
  Logger.log('PASS testLegacyGroupRecordSafetyHelpers：舊群組名稱唯一性與安全 fallback。');
}

function testBackupSheetHeaderMappingHelpers() {
  var oldHeaders = [
    'LINE 訊息時間', '來源類型', '群組名稱', '傳送者識別', '訊息類型',
    '原始檔名', '文字內容', '網址', '標籤', 'Drive File ID', 'Drive 連結',
    'webhookEventId', 'messageId', '狀態', '錯誤訊息'
  ];
  var missing = getMissingBackupSheetHeaders_(oldHeaders);
  assertTest_(missing.indexOf('傳送者名稱') >= 0, '舊 Sheet 缺少傳送者名稱時應補欄。');
  assertTest_(missing.indexOf('群組識別') >= 0, '舊 Sheet 缺少群組識別時應補欄。');
  var reorderedHeaders = [
    '傳送者名稱', 'messageId', '傳送者識別', '來源類型', 'LINE 訊息時間',
    '訊息類型', '狀態', '錯誤訊息'
  ];
  var row = buildBackupRecordRowByHeaders_(reorderedHeaders, {
    messageTimestamp: Date.now(),
    sourceType: '個人',
    senderHash: 'a'.repeat(64),
    senderDisplayName: '=危險名稱',
    messageType: 'text',
    messageId: 'manual-message-id',
    status: '完成',
    errorMessage: ''
  });
  assertTest_(row[0] === "'=危險名稱", '傳送者名稱遇到公式前綴時應安全處理。');
  assertTest_(row[1] === 'manual-message-id', '寫入資料應依標題名稱對應，不依固定欄位 index。');
  assertTest_(row[2] === 'a'.repeat(64), '傳送者識別應保留安全雜湊。');
  Logger.log('PASS testBackupSheetHeaderMappingHelpers：標題補欄、欄位對應與公式注入防護。');
}

function testBackupRecordDisplayNameHelpers() {
  var personalRow = buildBackupRecordRowByHeaders_(BACKUP_SHEET_HEADERS_, {
    messageTimestamp: Date.now(),
    sourceType: '個人',
    senderHash: 'a'.repeat(64),
    senderDisplayName: '私人使用者',
    messageType: 'text',
    rawText: '文字測試',
    status: '完成'
  });
  var senderNameIndex = BACKUP_SHEET_HEADERS_.indexOf('傳送者名稱');
  var senderHashIndex = BACKUP_SHEET_HEADERS_.indexOf('傳送者識別');
  assertTest_(personalRow[senderNameIndex] === '私人使用者', '私訊文字應寫入傳送者名稱。');
  assertTest_(personalRow[senderHashIndex] === 'a'.repeat(64), '傳送者識別應為實際發話者雜湊。');

  var groupRow = buildBackupRecordRowByHeaders_(BACKUP_SHEET_HEADERS_, {
    messageTimestamp: Date.now(),
    sourceType: '群組',
    groupName: '測試群組',
    groupHash: 'b'.repeat(64),
    senderHash: 'b'.repeat(64),
    senderDisplayName: '群組成員',
    messageType: 'text',
    rawText: '#筆記 測試',
    status: '完成'
  });
  assertTest_(groupRow[senderNameIndex] === '群組成員', '群組筆記應寫入實際發話者名稱。');
  assertTest_(groupRow[senderHashIndex] === 'b'.repeat(64), '群組傳送者識別不可改成 owner 或 Bot 雜湊。');
  var groupHashIndex = BACKUP_SHEET_HEADERS_.indexOf('群組識別');
  assertTest_(groupRow[groupHashIndex] === 'b'.repeat(64), '群組紀錄應寫入安全群組識別。');
  Logger.log('PASS testBackupRecordDisplayNameHelpers：私訊、附件與群組筆記名稱欄位。');
}

function testGroupBackupQueryHelpers() {
  var now = new Date('2026-08-18T12:00:00+08:00').getTime();
  var currentMonth = parseGroupSummaryQuery_('備份清單', now);
  assertTest_(currentMonth.label === '2026/08', '備份清單應查詢目前月份。');
  assertTest_(parseGroupSummaryQuery_('今日備份清單', now).startDate === '2026-08-18', '今日日期範圍不正確。');
  assertTest_(parseGroupSummaryQuery_('本週備份清單', now).startDate === '2026-08-17', '本週應從星期一開始。');
  assertTest_(parseGroupSummaryQuery_('8月備份清單', now).label === '2026/08', '月份查詢解析失敗。');
  assertTest_(parseGroupSummaryQuery_('2026年8月備份清單', now).label === '2026/08', '年月份查詢解析失敗。');
  assertTest_(parseGroupSummaryQuery_('2026-08 備份清單', now).label === '2026/08', 'ISO 年月份查詢解析失敗。');
  assertTest_(parseGroupSummaryQuery_('13月備份清單', now) === null, '無效月份應拒絕。');
  assertTest_(getGroupQuerySafeCode_('abcdef1234567890') === 'g_abcdef12', '群組安全代號格式不正確。');
  var safeSummary = formatGroupSummaryReply_({ GroupName: '測試群組' }, currentMonth, {
    records: [{
      'LINE 訊息時間': '2026-08-18 10:00:00',
      '訊息類型': 'file',
      '原始檔名': '文件.pdf',
      '狀態': '完成'
    }],
    counts: { image: 0, video: 0, audio: 0, file: 1, note: 0, text: 0 },
    legacyFallback: false
  });
  assertTest_(safeSummary.indexOf('drive.google.com') < 0, '群組摘要不可顯示 Drive 連結。');
  assertTest_(safeSummary.indexOf('webhook') < 0, '群組摘要不可顯示工作識別。');
  assertTest_(safeSummary.indexOf('最新 1 筆') >= 0, '群組摘要應限制並顯示最新紀錄數量。');
  Logger.log('PASS testGroupBackupQueryHelpers：群組日期解析、摘要與安全代號。');
}

function testGroupRecordQueryTokenHelpers() {
  var lineUserHash = 'a'.repeat(64);
  var groupHash = 'b'.repeat(64);
  var token = createRecordQueryToken_(
    lineUserHash,
    Date.now() + 600000,
    '0123456789abcdef0123456789abcdef',
    'TEST_QUERY_SECRET',
    groupHash,
    '2026-08-01',
    '2026-08-31'
  );
  var payload = decodeRecordQueryPayload_(token.split('.')[0]);
  assertTest_(payload.version === 2, '群組查詢 Token 應使用獨立版本。');
  assertTest_(payload.groupIdHash === groupHash, '群組查詢 Token 必須綁定群組雜湊。');
  assertTest_(isRecordQueryPayloadValid_(payload), '群組查詢 Token 格式應有效。');
  assertTest_(token.indexOf(groupHash) < 0, '完整群組雜湊不可直接出現在編碼 Token。');
  Logger.log('PASS testGroupRecordQueryTokenHelpers：使用者、群組與期限綁定。');
}

function testDriveQuotaHelpers() {
  var mockHash = 'a'.repeat(64);
  assertTest_(formatDriveQuotaBytes_(1024) === '1 KB', '1024 bytes 應格式化為 1 KB。');
  assertTest_(formatDriveQuotaBytes_(1024 * 1024) === '1 MB', 'MiB 應正確格式化。');
  assertTest_(formatDriveQuotaPercentage_(50, 200) === '25.0%', '使用率應保留 1 位小數。');
  assertTest_(formatDriveQuotaPercentage_(50, null) === null, '無容量上限時不可計算使用率。');
  assertTest_(
    getDriveQuotaUserMessage_({ httpStatus: 403, googleReason: 'insufficientPermissions' }) ===
      '目前 Google Drive 授權不足，請重新輸入「綁定」完成授權。',
    'Drive 403 insufficientPermissions 應回覆重新綁定提示。'
  );
  assertTest_(
    getDriveQuotaUserMessage_({ httpStatus: 500 }) === '暫時無法取得容量資訊，請稍後再試。',
    'Drive 暫時錯誤應回覆安全訊息。'
  );
  var limitedReply = formatPersonalDriveQuotaReply_({
    limit: 1000,
    usage: 250,
    usageInDrive: 200,
    usageInDriveTrash: 50,
    lineBackupUsage: 100,
    updatedAt: '2026/08/09 12:30'
  });
  assertTest_(limitedReply.indexOf('剩餘容量：750 B') >= 0, '應顯示剩餘容量。');
  assertTest_(limitedReply.indexOf('使用率：25.0%') >= 0, '應顯示使用率。');
  var unlimitedReply = formatPersonalDriveQuotaReply_({
    limit: null,
    usage: 250,
    usageInDrive: 200,
    usageInDriveTrash: 50,
    lineBackupUsage: 100,
    updatedAt: '2026/08/09 12:30'
  });
  assertTest_(unlimitedReply.indexOf('總容量：未提供或無限制') >= 0, '無上限時應顯示未提供或無限制。');
  assertTest_(unlimitedReply.indexOf('剩餘容量：') < 0, '無上限時不可顯示計算後的剩餘容量。');
  assertTest_(sumDriveFileSizes_([
    { mimeType: 'text/plain', size: '1024' },
    { mimeType: 'application/vnd.google-apps.document' },
    { mimeType: 'application/vnd.google-apps.folder', size: '2048' }
  ]) === 1024, 'Google 原生文件與資料夾無 size 時不可造成錯誤。');
  var cache = CacheService.getScriptCache();
  cache.remove(getDriveQuotaCacheKey_(mockHash));
  var computeCount = 0;
  var first = getOrComputeDriveQuotaResult_(mockHash, function () {
    computeCount += 1;
    return { lineBackupUsage: 123, updatedAt: '2026/08/09 12:30' };
  });
  var second = getOrComputeDriveQuotaResult_(mockHash, function () {
    computeCount += 1;
    return { lineBackupUsage: 456, updatedAt: '2026/08/09 12:31' };
  });
  assertTest_(computeCount === 1 && first.lineBackupUsage === second.lineBackupUsage, '10 分鐘快取內不可重掃 Drive。');
  cache.remove(getDriveQuotaCacheKey_(mockHash));
  var childrenUrl = buildDriveChildrenListUrl_('FOLDER_TEST_123', '');
  assertTest_(childrenUrl.indexOf('q=') >= 0 && childrenUrl.indexOf('fields=') >= 0, 'Drive files.list 查詢應安全包含 q 與 fields。');
  Logger.log('PASS testDriveQuotaHelpers：容量格式化、無上限、檔案大小加總與 10 分鐘快取。');
}

function testDriveQuotaUserBindingCompatibility() {
  var legacyEnabledUser = { Enabled: true, ApprovalStatus: '' };
  var stringEnabledLegacyUser = { Enabled: 'TRUE', ApprovalStatus: '' };
  var approvedUser = { Enabled: true, ApprovalStatus: USER_APPROVAL_STATUS_.APPROVED };
  var pendingUser = { Enabled: false, ApprovalStatus: USER_APPROVAL_STATUS_.PENDING };
  var disabledUser = { Enabled: false, ApprovalStatus: USER_APPROVAL_STATUS_.APPROVED };

  assertTest_(getUserApprovalStatus_(legacyEnabledUser) === USER_APPROVAL_STATUS_.APPROVED,
    '舊使用者 ApprovalStatus 空白且 Enabled=true 應視為 APPROVED。');
  assertTest_(isApprovedEnabledUser_(legacyEnabledUser), '舊使用者應可通過容量查詢啟用判斷。');
  assertTest_(isApprovedEnabledUser_(stringEnabledLegacyUser), '字串 TRUE 的舊使用者應可相容判斷。');
  assertTest_(isApprovedEnabledUser_(approvedUser), 'APPROVED 且 Enabled=true 應可查詢容量。');
  assertTest_(!isApprovedEnabledUser_(pendingUser), 'PENDING_APPROVAL 使用者不可查詢容量。');
  assertTest_(!isApprovedEnabledUser_(disabledUser), 'Enabled=false 使用者不可查詢容量。');
  assertTest_(getDriveQuotaUserMessage_({ appCode: 'DRIVE_QUOTA_USER_NOT_ENABLED' }) ===
    '請先完成 Google 帳號綁定後再查詢容量。', '未綁定或未啟用應顯示綁定提示。');
  assertTest_(getDriveQuotaUserMessage_({ appCode: 'OAUTH_TOKEN_MISSING' }) ===
    'Google 授權已失效，請重新輸入「綁定」完成授權。', 'OAuth Token 不存在應顯示授權失效提示。');
  assertTest_(getDriveQuotaUserMessage_({ appCode: 'OAUTH_TOKEN_READ_FAILED' }) ===
    'Google 授權已失效，請重新輸入「綁定」完成授權。', 'OAuth Token 讀取失敗應顯示授權失效提示。');
  assertTest_(getDriveQuotaUserMessage_({
    httpStatus: 403,
    googleReason: 'insufficientPermissions'
  }) === '目前 Google Drive 授權不足，請重新輸入「綁定」完成授權。',
  'Drive 403 insufficientPermissions 應顯示授權不足提示。');
  Logger.log('PASS testDriveQuotaUserBindingCompatibility：舊版、核准、待審核與授權失效分流。');
}

function testAdminApprovalSafetyHelpers() {
  var adminHash = 'b'.repeat(64);
  var otherHash = 'c'.repeat(64);
  assertTest_(
    isAdminLineUserHashConfigured_(adminHash, [adminHash]),
    '管理者雜湊在白名單內應可通過。'
  );
  assertTest_(
    !isAdminLineUserHashConfigured_(otherHash, [adminHash]),
    '不在白名單內的使用者不可執行管理者指令。'
  );
  assertTest_(
    !isAdminLineUserHashConfigured_('not-a-hash', [adminHash]),
    '不符合格式的識別不可視為管理者。'
  );
  assertTest_(getUserReviewCode_(adminHash) === 'UBBBBBBBB', '審核代號只能由雜湊前綴產生。');
  console.log('管理者審核安全輔助測試通過。');
}

function testGroupPermissionHelpers() {
  var ownerHash = 'a'.repeat(64);
  var memberHash = 'b'.repeat(64);
  var adminHash = 'c'.repeat(64);
  var group = { OwnerLineUserHash: ownerHash, Enabled: true };
  var approvedOwner = {
    LineUserHash: ownerHash,
    Enabled: true,
    ApprovalStatus: USER_APPROVAL_STATUS_.APPROVED
  };
  var unapprovedMember = {
    LineUserHash: memberHash,
    Enabled: false,
    ApprovalStatus: USER_APPROVAL_STATUS_.PENDING
  };
  assertTest_(
    canGroupMemberSubmitBackup_(group, approvedOwner),
    '群組成員提供內容時，只要 owner 已核准即可備份。'
  );
  assertTest_(
    !canGroupMemberSubmitBackup_(group, null),
    '群組 owner 未核准時不可備份。'
  );
  assertTest_(isGroupManager_(group, ownerHash), '群組 owner 應可操作群組管理指令。');
  assertTest_(!isGroupManager_(group, memberHash), '一般群組成員不可操作群組管理指令。');
  assertTest_(
    getGroupCommandRestrictionMessage_('pendingApproval') === '管理指令請私訊 Bot 執行。',
    '群組不可執行管理者審核指令。'
  );
  assertTest_(
    getGroupCommandRestrictionMessage_('bind') === '個人綁定請私訊 Bot 執行，避免授權連結曝光。',
    '群組不可產生個人 OAuth 綁定連結。'
  );
  assertTest_(
    getGroupCommandRestrictionMessage_('reauthorize') === '個人重新授權請私訊 Bot 執行。',
    '群組不可產生個人重新授權連結。'
  );
  assertTest_(
    getGroupCommandRestrictionMessage_('records') === '紀錄查詢請私訊 Bot 執行。',
    '群組不可直接開啟個人紀錄查詢連結。'
  );
  assertTest_(
    getGroupCommandRestrictionMessage_('quota') === '容量資訊屬於個人 Google Drive，請私訊 Bot 輸入「容量」查詢。',
    '群組不可公開顯示個人容量。'
  );
  assertTest_(
    getGroupCommandRestrictionMessage_('groupQuota') === '容量資訊屬於個人 Google Drive，請私訊 Bot 輸入「容量」查詢。',
    '群組不可公開顯示群組 owner 容量。'
  );
  assertTest_(getGroupCommandRestrictionMessage_('status') === null, '群組狀態指令應保留。');
  assertTest_(getGroupCommandRestrictionMessage_('groupSummary') === null, '群組備份清單摘要應允許成員查詢。');
  assertTest_(
    getGroupCommandRestrictionMessage_('groupRecords') === '群組完整紀錄請私訊 Bot 執行。',
    '群組完整紀錄不可在群組內公開。'
  );
  assertTest_(getGroupStatusMessage_(group) === '此群組已綁定', '群組狀態只應顯示綁定狀態。');
  assertTest_(getGroupStatusMessage_(null) === '此群組尚未綁定', '未綁定群組狀態應安全顯示。');

  var properties = PropertiesService.getScriptProperties();
  var previousAdmins = properties.getProperty(APP_CONFIG_KEYS_.ADMIN_LINE_USER_HASHES);
  try {
    properties.setProperty(APP_CONFIG_KEYS_.ADMIN_LINE_USER_HASHES, adminHash);
    assertTest_(isGroupManager_(group, adminHash), '管理者應可操作群組管理指令。');
  } finally {
    if (previousAdmins === null) {
      properties.deleteProperty(APP_CONFIG_KEYS_.ADMIN_LINE_USER_HASHES);
    } else {
      properties.setProperty(APP_CONFIG_KEYS_.ADMIN_LINE_USER_HASHES, previousAdmins);
    }
  }
  assertTest_(!isApprovedEnabledUser_(unapprovedMember), '未核准成員不可被誤視為 owner。');
  Logger.log('PASS testGroupPermissionHelpers：群組成員備份與 owner／管理者權限。');
}

function testBatchApprovalHelpers() {
  var pendingUsers = [
    { _row: 2, LineUserHash: 'a'.repeat(64), Enabled: false, ApprovalStatus: USER_APPROVAL_STATUS_.PENDING },
    { _row: 3, LineUserHash: 'b'.repeat(64), Enabled: false, ApprovalStatus: USER_APPROVAL_STATUS_.PENDING },
    { _row: 4, LineUserHash: 'c'.repeat(64), Enabled: true, ApprovalStatus: USER_APPROVAL_STATUS_.APPROVED },
    { _row: 5, LineUserHash: 'd'.repeat(64), Enabled: false, ApprovalStatus: USER_APPROVAL_STATUS_.REJECTED }
  ];
  var tokens = parseApprovalTargetTokens_('1,2,3');
  assertTest_(tokens.length === 3 && tokens[0] === '1' && tokens[2] === '3', '逗號編號應正確解析。');
  var resolved = resolveApprovalTargets_('1,2,3', pendingUsers.slice(0, 2));
  assertTest_(resolved.targets.length === 2 && resolved.skipped === 1, '多筆編號應只解析目前可審核使用者。');
  assertTest_(isPendingApprovalUser_(pendingUsers[0]), 'PENDING_APPROVAL 且停用的使用者應可進入批次。');
  assertTest_(!isPendingApprovalUser_(pendingUsers[2]), '已核准使用者不可再次批次處理。');
  assertTest_(!isPendingApprovalUser_(pendingUsers[3]), '已拒絕使用者不可再次批次處理。');
  Logger.log('PASS testBatchApprovalHelpers：多筆審核與重複處理防護。');
}

function testApprovalConfirmationExpiry() {
  var managerHash = 'e'.repeat(64);
  var code = 'ABCD1234';
  var now = Date.now();
  var validRecord = {
    operation: 'APPROVE_ALL',
    expiresAt: now + 300000,
    codeHash: hashIdentifier_('APPROVAL_CONFIRM:' + managerHash + ':' + code)
  };
  assertTest_(
    isApprovalConfirmationValid_(validRecord, managerHash, 'APPROVE_ALL', code, now),
    '未過期且綁定管理者的確認碼應有效。'
  );
  assertTest_(
    !isApprovalConfirmationValid_(validRecord, managerHash, 'APPROVE_ALL', code, now + 300001),
    '確認碼過期後不可執行。'
  );
  assertTest_(
    !isApprovalConfirmationValid_(validRecord, 'f'.repeat(64), 'APPROVE_ALL', code, now),
    '其他管理者不可代用確認碼。'
  );
  assertTest_(
    !isApprovalConfirmationValid_(validRecord, managerHash, 'REJECT_ALL', code, now),
    '核准確認碼不可改作拒絕操作。'
  );
  Logger.log('PASS testApprovalConfirmationExpiry：確認碼期限與管理者綁定。');
}

function testApprovalConfirmationFlow() {
  var properties = PropertiesService.getScriptProperties();
  var managerHash = 'a'.repeat(64);
  var previousAdmins = properties.getProperty(APP_CONFIG_KEYS_.ADMIN_LINE_USER_HASHES);
  try {
    properties.setProperty(APP_CONFIG_KEYS_.ADMIN_LINE_USER_HASHES, managerHash);
    var confirmation = createApprovalConfirmation_(managerHash, 'APPROVE_ALL');
    assertTest_(consumeApprovalConfirmation_(managerHash, 'APPROVE_ALL', confirmation.code), '第一次確認應成功消耗確認碼。');
    var replayRejected = false;
    try {
      consumeApprovalConfirmation_(managerHash, 'APPROVE_ALL', confirmation.code);
    } catch (error) {
      replayRejected = isAppError_(error) && error.appCode === 'APPROVAL_CONFIRMATION_INVALID';
    }
    assertTest_(replayRejected, '確認碼消耗後不得再次執行整批操作。');
  } finally {
    if (previousAdmins === null) {
      properties.deleteProperty(APP_CONFIG_KEYS_.ADMIN_LINE_USER_HASHES);
    } else {
      properties.setProperty(APP_CONFIG_KEYS_.ADMIN_LINE_USER_HASHES, previousAdmins);
    }
  }
  Logger.log('PASS testApprovalConfirmationFlow：二次確認與防重播。');
}

function testBindingProvisioningReusesResources() {
  var testUser = getManualTestUser_();
  var first = ensureUserResources_(testUser.accessToken, testUser.lineUserHash, null);
  var second = ensureUserResources_(testUser.accessToken, testUser.lineUserHash, null);
  assertTest_(JSON.stringify(first) === JSON.stringify(second), '相同使用者重試必須重用同一組資料夾與 Sheet。');
  console.log('綁定資源冪等重用測試通過。');
}

/** 部署前先執行一次。 */
function initializeAdminSpreadsheet() {
  ensureAdminSheets_();
  console.log('管理試算表初始化完成。');
}

/** 可由另一個暫存測試函式呼叫；原始邀請碼不會寫入管理試算表。 */
function createInvitation(inviteCode, maximumUses, expiresAtIso) {
  createInvitationForAdmin_(inviteCode, maximumUses, new Date(expiresAtIso));
  console.log('邀請碼雜湊已建立。');
}

/**
 * 非專業管理者可暫時設定 NEW_INVITE_CODE、NEW_INVITE_MAX_USES、NEW_INVITE_EXPIRES_AT，
 * 再執行本函式。原始邀請碼不會寫入工作表，且暫存 Properties 會立即刪除。
 */
function createInvitationFromTemporaryProperties() {
  var properties = PropertiesService.getScriptProperties();
  var inviteCode = properties.getProperty('NEW_INVITE_CODE');
  var maximumUses = Number(properties.getProperty('NEW_INVITE_MAX_USES'));
  var expiresAt = properties.getProperty('NEW_INVITE_EXPIRES_AT');
  try {
    createInvitation(inviteCode, maximumUses, expiresAt);
  } finally {
    properties.deleteProperty('NEW_INVITE_CODE');
    properties.deleteProperty('NEW_INVITE_MAX_USES');
    properties.deleteProperty('NEW_INVITE_EXPIRES_AT');
  }
}
