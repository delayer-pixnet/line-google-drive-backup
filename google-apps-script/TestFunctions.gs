function assertTest_(condition, message) {
  if (!condition) {
    throw new Error('測試失敗：' + message);
  }
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
    lineUserId: 'Umanual-processing-test',
    groupId: null,
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
