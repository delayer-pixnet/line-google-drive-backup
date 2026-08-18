function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(request) {
  var route = request && request.parameter ? request.parameter.route : '';
  if (route === 'bind') {
    try {
      return renderBindPage_(request.parameter.token || '');
    } catch (error) {
      var template = HtmlService.createTemplateFromFile('ResultPage');
      template.success = false;
      template.message = isAppError_(error) ? error.safeMessage : '綁定連結無效，請回 LINE 重新取得。';
      return template.evaluate().setTitle('綁定連結無效');
    }
  }
  if (route === 'query') {
    try {
      var queryToken = request.parameter.token || '';
      var queryPayload = verifyRecordQueryToken_(queryToken);
      var queryTemplate = HtmlService.createTemplateFromFile('RecordSearchPage');
      queryTemplate.queryToken = queryToken;
      queryTemplate.groupMode = Boolean(queryPayload.groupIdHash);
      queryTemplate.queryStartDate = queryPayload.startDate || '';
      queryTemplate.queryEndDate = queryPayload.endDate || '';
      return queryTemplate.evaluate()
        .setTitle('LINE 記錄搜尋中心')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
    } catch (error) {
      var queryResult = HtmlService.createTemplateFromFile('ResultPage');
      queryResult.success = false;
      queryResult.message = isAppError_(error) && error.appCode === 'RECORD_QUERY_TOKEN_EXPIRED'
        ? '查詢連結已過期，請回 LINE 重新輸入「紀錄」取得新連結。'
        : '查詢連結無效，請回 LINE 重新輸入「紀錄」取得新連結。';
      return queryResult.evaluate().setTitle('查詢連結無效');
    }
  }
  if (route === 'q') {
    try {
      var shortCode = request.parameter.id || '';
      var shortPayload = verifyRecordQueryShortCode_(shortCode);
      var shortTemplate = HtmlService.createTemplateFromFile('RecordSearchPage');
      shortTemplate.queryToken = shortCode;
      shortTemplate.groupMode = Boolean(shortPayload.groupIdHash);
      shortTemplate.queryStartDate = shortPayload.startDate || '';
      shortTemplate.queryEndDate = shortPayload.endDate || '';
      shortTemplate.legacyNotice = '';
      return shortTemplate.evaluate()
        .setTitle('LINE 記錄搜尋中心')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
    } catch (error) {
      var shortResult = HtmlService.createTemplateFromFile('ResultPage');
      shortResult.success = false;
      shortResult.message = isAppError_(error) && error.appCode === 'RECORD_QUERY_TOKEN_EXPIRED'
        ? error.queryScope === 'group-record-query'
          ? '查詢連結已過期，請回 LINE 重新輸入「群組紀錄」取得新連結。'
          : '查詢連結已過期，請回 LINE 重新輸入「紀錄」取得新連結。'
        : '查詢連結無效，請回 LINE 重新取得新的查詢連結。';
      return shortResult.evaluate().setTitle('查詢連結無效');
    }
  }
  return jsonOutput_({ status: 'ok' });
}

function doPost(request) {
  var job = null;
  var envelope = null;
  var claimed = false;
  var envelopeVerified = false;
  try {
    var rawBody = request && request.postData ? request.postData.contents : '';
    if (typeof rawBody !== 'string' || rawBody.length === 0 || rawBody.length > 120000) {
      throw createAppError_('REQUEST_BODY_INVALID', false, '請求內容不正確。');
    }
    envelope = JSON.parse(rawBody);
    var payload = verifyWorkerEnvelope_(envelope);
    envelopeVerified = true;
    job = validateQueueJob_(JSON.parse(payload));
    var claim = claimJob_(job);
    claimed = claim.claimed;
    if (!claimed) {
      if (claim.status === 'PROCESSING') {
        return jsonOutput_({
          ok: false,
          retryable: true,
          errorCode: 'JOB_IN_PROGRESS',
          retryAfterSeconds: Number.isSafeInteger(claim.retryAfterSeconds)
            ? claim.retryAfterSeconds
            : 60
        });
      }
      return jsonOutput_({ ok: true });
    }
    var result = processJob_(job);
    if (result.jobStatus === 'REJECTED') {
      rejectJob_(job.webhookEventId, result.errorCode || 'REJECTED', result.safeMessage || '工作已安全拒絕。');
    } else {
      completeJob_(job.webhookEventId, result.driveFileId || '');
    }
    var response = { ok: true };
    if (result.replyMessage) {
      response.replyMessage = result.replyMessage;
    }
    if (result.backupSuccessReply === true) {
      response.backupSuccessReply = true;
    }
    return jsonOutput_(response);
  } catch (error) {
    var appError = isAppError_(error)
      ? error
      : createAppError_('UNEXPECTED_ERROR', true, '系統暫時無法完成備份。');
    var correlationId = job && job.webhookEventId ? job.webhookEventId : 'request';
    safeLog_('error', 'gas', appError.appCode, correlationId);
    if (envelopeVerified) {
      try {
        recordSafeError_('gas', appError.appCode, appError.safeMessage, correlationId);
      } catch (loggingError) {
        safeLog_('error', 'gas-log', 'SAFE_LOG_WRITE_FAILED', correlationId);
      }
      if (claimed && job) {
        try {
          var approvalRejected = ['USER_NOT_APPROVED', 'GROUP_OWNER_NOT_APPROVED'].indexOf(appError.appCode) >= 0;
          if (approvalRejected) {
            rejectJob_(job.webhookEventId, appError.appCode, appError.safeMessage);
          } else {
            failJob_(job.webhookEventId, appError.appCode, appError.safeMessage);
          }
        } catch (jobUpdateError) {
          safeLog_('error', 'gas-job', 'JOB_FAILURE_UPDATE_FAILED', correlationId);
        }
      }
    }
    var response = {
      ok: false,
      retryable: appError.retryable === true,
      errorCode: appError.appCode,
      replyMessage: appError.retryable === true ? undefined : appError.safeMessage
    };
    if (
      isHmacDiagnosticEnabled_() &&
      appError.appCode === 'SIGNATURE_INVALID' &&
      envelope
    ) {
      try {
        response.diagnostic = buildHmacDiagnostic_(envelope);
      } catch (diagnosticError) {
        safeLog_('warn', 'gas-diagnostic', 'DIAGNOSTIC_BUILD_FAILED', correlationId);
      }
    }
    return jsonOutput_(response);
  }
}

function processJob_(job) {
  if (job.eventType === 'follow') {
    return { replyMessage: getHelpMessage_(job) };
  }
  if (job.eventType === 'unfollow') {
    if (job.lineUserHash) {
      unlinkGoogleAccount_(job.lineUserHash);
    }
    return {};
  }
  if (job.eventType === 'join') {
    return { replyMessage: 'Bot 已加入群組。請由預定的備份擁有者輸入「綁定群組」。' };
  }
  if (job.eventType === 'leave') {
    if (job.groupIdHash) {
      disableGroup_(job.groupIdHash, null);
    }
    return {};
  }
  if (job.eventType === 'unsend') {
    return processUnsend_(job);
  }
  if (job.command && job.command !== 'note') {
    return processCommand_(job);
  }
  return backupMessage_(job);
}

function getHelpMessage_(job) {
  if (job && job.groupIdHash) {
    return [
      '群組可用指令：',
      '',
      '#筆記 <內容>：保存群組文字筆記',
      '狀態：查詢本群組是否已綁定',
      '綁定群組：設定群組備份擁有者',
      '解除群組：解除群組備份綁定，僅限群組 owner 或管理者',
      '容量：容量資訊屬於個人 Google Drive，請私訊 Bot 輸入「容量」查詢',
      '備份清單：查詢本月群組備份摘要',
      '今日備份清單：查詢今天群組備份摘要',
      '本週備份清單：查詢本週群組備份摘要',
      '8月備份清單：查詢指定月份群組備份摘要',
      '',
      '群組附件備份規則：',
      '群組已綁定後，成員傳送圖片、影片、音訊、PDF、DOCX、XLSX、TXT、XML 等檔案，會備份到群組備份擁有者的 Google Drive。',
      '群組附件成功預設不回覆，避免洗版。',
      '群組 #筆記 成功會回覆「✅ 筆記已備份。」',
      '',
      '個人綁定、紀錄查詢、容量查詢與管理者審核指令請私訊 Bot 執行。'
    ].join('\n');
  }
  var lines = [
    '可用指令：',
    '',
    '【個人綁定】',
    '綁定：自助連結自己的 Google 帳號',
    '綁定 <邀請碼>：使用管理者邀請碼連結 Google 帳號',
    '重新授權：更新 Google OAuth Token，不重建既有 Drive／Sheet',
    '狀態：查詢個人綁定狀態',
    '解除綁定：清除 Google 授權 Token',
    '',
    '【個人備份】',
    '直接傳文字、圖片、影片、音訊或檔案給 Bot，即可備份到自己的 Google Drive。',
    '支援常見檔案格式，例如 PDF、TXT、XML、DOCX、XLSX。',
    '單檔大小限制：20 MB 以下。',
    '',
    '【紀錄查詢】',
    '紀錄：取得 10 分鐘有效的 LINE 記錄搜尋中心連結',
    '查詢紀錄：同「紀錄」',
    '',
    '【容量查詢】',
    '容量：查詢 Google Drive 總容量、已使用容量與 LINE 備份資料夾估算容量',
    '空間：同「容量」',
    'Drive容量：同「容量」',
    '',
      '【群組使用】',
      '#筆記 <內容>：在已綁定群組中保存文字筆記',
      '群組附件會備份到群組備份擁有者的 Google Drive。',
      '群組紀錄：群組備份擁有者可私訊查詢完整紀錄',
    '個人綁定請私訊 Bot 執行。',
    '',
    '說明：顯示本說明'
  ];
  if (job && job.lineUserHash && isAdminLineUserHash_(job.lineUserHash)) {
    lines.push('', '【管理者指令】（僅管理者可見）');
    lines.push('待審核：查看待審核使用者');
    lines.push('核准 <編號[,編號]>：核准一筆或多筆使用者');
    lines.push('拒絕 <編號[,編號]>：拒絕一筆或多筆使用者');
    lines.push('核准全部：建立整批核准確認碼');
    lines.push('拒絕全部：建立整批拒絕確認碼');
    lines.push('確認核准全部 <確認碼>：執行整批核准');
    lines.push('確認拒絕全部 <確認碼>：執行整批拒絕');
  }
  return lines.join('\n');
}

function processCommand_(job) {
  if (!job.lineUserHash) {
    return { replyMessage: 'LINE 未提供傳送者識別，無法執行此指令。' };
  }
  var lineUserHash = job.lineUserHash;
  if (job.groupIdHash) {
    var groupCommandRestriction = getGroupCommandRestrictionMessage_(job.command);
    if (groupCommandRestriction) {
      return { replyMessage: groupCommandRestriction };
    }
  }
  if (job.command === 'pendingApproval') {
    assertAdminUser_(lineUserHash);
    return { replyMessage: listPendingApprovalUsers_() };
  }
  if (job.command === 'approve' || job.command === 'reject') {
    assertAdminUser_(lineUserHash);
    var approvalStatus = job.command === 'approve'
      ? USER_APPROVAL_STATUS_.APPROVED
      : USER_APPROVAL_STATUS_.REJECTED;
    var argument = getApprovalCommandArgument_(job);
    if (argument === '全部') {
      var pendingCount = getPendingApprovalUsers_().length;
      if (pendingCount === 0) {
        return { replyMessage: '目前沒有可批次處理的待審核使用者。' };
      }
      var confirmation = createApprovalConfirmation_(
        lineUserHash,
        approvalStatus === USER_APPROVAL_STATUS_.APPROVED ? 'APPROVE_ALL' : 'REJECT_ALL'
      );
      var confirmationCommand = approvalStatus === USER_APPROVAL_STATUS_.APPROVED
        ? '確認核准全部'
        : '確認拒絕全部';
      return {
        replyMessage: '目前有 ' + pendingCount + ' 筆待處理。請在 5 分鐘內輸入：\n' +
          confirmationCommand + ' ' + confirmation.code
      };
    }
    if (argument && argument.indexOf(',') < 0 && /^U[A-F0-9]{8}$/i.test(argument)) {
      updateUserApprovalByReviewCode_(argument, approvalStatus);
      return {
        replyMessage: approvalStatus === USER_APPROVAL_STATUS_.APPROVED
          ? '已核准該使用者，現在可以開始備份。'
          : '已拒絕該使用者，帳號不會執行備份。'
      };
    }
    var resolution = resolveApprovalTargets_(argument);
    var batchResult = applyApprovalUpdates_(resolution.targets, approvalStatus);
    batchResult.skipped += resolution.skipped;
    return { replyMessage: formatApprovalBatchResult_(approvalStatus, batchResult) };
  }
  if (job.command === 'confirmApproveAll' || job.command === 'confirmRejectAll') {
    assertAdminUser_(lineUserHash);
    var confirmationCode = getApprovalConfirmationCommandArgument_(job);
    var confirmationOperation = job.command === 'confirmApproveAll' ? 'APPROVE_ALL' : 'REJECT_ALL';
    consumeApprovalConfirmation_(lineUserHash, confirmationOperation, confirmationCode);
    var allApprovalStatus = job.command === 'confirmApproveAll'
      ? USER_APPROVAL_STATUS_.APPROVED
      : USER_APPROVAL_STATUS_.REJECTED;
    var allResult = applyApprovalUpdates_(getPendingApprovalUsers_(), allApprovalStatus);
    return { replyMessage: formatApprovalBatchResult_(allApprovalStatus, allResult) };
  }
  if (job.command === 'help') {
    return { replyMessage: getHelpMessage_(job) };
  }
  if (job.command === 'records') {
    return { replyMessage: createRecordQueryLink_(lineUserHash) };
  }
  if (job.command === 'groupSummary') {
    return { replyMessage: getGroupBackupSummaryReply_(job) };
  }
  if (job.command === 'groupRecords') {
    return { replyMessage: getGroupRecordQueryReply_(lineUserHash, job) };
  }
  if (job.command === 'quota') {
    return { replyMessage: getPersonalDriveQuotaReply_(lineUserHash) };
  }
  if (job.command === 'groupQuota') {
    return { replyMessage: getOwnedGroupDriveQuotaReply_(lineUserHash) };
  }
  if (job.command === 'reauthorize') {
    return createReauthorizationReply_(job, lineUserHash);
  }
  if (job.command === 'bind') {
    var inviteCode = String(job.rawText || '').replace(/^綁定\s*/u, '').trim();
    if (!inviteCode) {
      if (!isSelfServiceBindingEnabled_()) {
        return { replyMessage: '請輸入「綁定 <邀請碼>」。邀請碼請向管理者取得。' };
      }
      var existingUser = findUserByHash_(lineUserHash);
      var existingStatus = getUserApprovalStatus_(existingUser);
      if (existingUser && existingUser.GoogleSubjectId && existingStatus === USER_APPROVAL_STATUS_.APPROVED) {
        return { replyMessage: '目前已完成 Google 綁定；若需更新授權，請輸入「重新授權」。' };
      }
      if (existingUser && existingUser.GoogleSubjectId && existingStatus === USER_APPROVAL_STATUS_.PENDING) {
        return { replyMessage: 'Google 授權已完成，目前等待管理者審核。' };
      }
      if (!job.bindToken) {
        throw createAppError_('BIND_TOKEN_MISSING', false, '無法建立綁定連結，請重試。');
      }
      var selfServiceBindPayload = verifyBindToken_(job.bindToken);
      if (!constantTimeEqual_(selfServiceBindPayload.lineUserHash, lineUserHash)) {
        throw createAppError_('BIND_TOKEN_USER_MISMATCH', false, '綁定資料驗證失敗。');
      }
      createBindingSession_(lineUserHash, selfServiceBindPayload.nonce, selfServiceBindPayload.expiresAt, null);
      var selfServiceBaseUrl = getRequiredProperty_(APP_CONFIG_KEYS_.APP_BASE_URL);
      return {
        replyMessage: '請在 10 分鐘內開啟以下私人綁定連結：\n' +
          selfServiceBaseUrl + '?route=bind&token=' + encodeURIComponent(job.bindToken)
      };
    }
    if (!findAvailableInvitationForBinding_(inviteCode)) {
      return { replyMessage: '邀請碼無效、已過期或已達使用次數。' };
    }
    if (!job.bindToken) {
      throw createAppError_('BIND_TOKEN_MISSING', false, '無法建立綁定連結，請重試。');
    }
    var bindPayload = verifyBindToken_(job.bindToken);
    if (!constantTimeEqual_(bindPayload.lineUserHash, lineUserHash)) {
      throw createAppError_('BIND_TOKEN_USER_MISMATCH', false, '綁定資料驗證失敗。');
    }
    createBindingSession_(
      lineUserHash,
      bindPayload.nonce,
      bindPayload.expiresAt,
      inviteCode
    );
    var baseUrl = getRequiredProperty_(APP_CONFIG_KEYS_.APP_BASE_URL);
    return {
      replyMessage: '請在 10 分鐘內開啟以下私人綁定連結：\n' +
        baseUrl + '?route=bind&token=' + encodeURIComponent(job.bindToken)
    };
  }
  if (job.command === 'status') {
    if (job.groupIdHash) {
      return {
        replyMessage: getGroupStatusMessage_(findEnabledGroupByHash_(job.groupIdHash))
      };
    }
    var user = findUserByHash_(lineUserHash);
    var userStatus = getUserApprovalStatus_(user);
    var userStatusMessage = !user
      ? 'Google 帳號：尚未綁定'
      : userStatus === USER_APPROVAL_STATUS_.PENDING
        ? 'Google 帳號：等待管理者審核'
        : userStatus === USER_APPROVAL_STATUS_.REJECTED
          ? 'Google 帳號：審核未通過'
          : 'Google 帳號：已綁定';
    var ownedGroups = getSheetRecords_('Groups').filter(function (record) {
      return record.OwnerLineUserHash === lineUserHash && record.Enabled === true;
    });
    return {
      replyMessage: userStatusMessage +
        '\n管理中的群組：' + ownedGroups.length + ' 個'
    };
  }
  if (job.command === 'unbind') {
    return {
      replyMessage: unlinkGoogleAccount_(lineUserHash)
        ? '已解除 Google 綁定並清除 OAuth Token；既有 Drive 檔案不會刪除。'
        : '目前沒有可解除的 Google 綁定。'
    };
  }
  if (job.command === 'bindGroup') {
    return bindGroup_(job, lineUserHash);
  }
  if (job.command === 'unbindGroup') {
    return unbindGroup_(job, lineUserHash);
  }
  return { replyMessage: '無法辨識指令，請輸入「說明」。' };
}

function createReauthorizationReply_(job, lineUserHash) {
  if (job.groupIdHash) {
    return { replyMessage: '個人重新授權請私訊 Bot 執行。' };
  }
  var existingUser = findUserByHash_(lineUserHash);
  if (!existingUser || !existingUser.GoogleSubjectId) {
    return { replyMessage: '目前沒有可重新授權的 Google 綁定，請先輸入「綁定」。' };
  }
  if (!job.bindToken) {
    throw createAppError_('BIND_TOKEN_MISSING', false, '無法建立重新授權連結，請重試。');
  }
  var bindPayload = verifyBindToken_(job.bindToken);
  if (!constantTimeEqual_(bindPayload.lineUserHash, lineUserHash)) {
    throw createAppError_('BIND_TOKEN_USER_MISMATCH', false, '重新授權資料驗證失敗。');
  }
  createBindingSession_(
    lineUserHash,
    bindPayload.nonce,
    bindPayload.expiresAt,
    null,
    true
  );
  var baseUrl = getRequiredProperty_(APP_CONFIG_KEYS_.APP_BASE_URL);
  return {
    replyMessage: '請在 10 分鐘內開啟以下私人重新授權連結：\n' +
      baseUrl + '?route=bind&token=' + encodeURIComponent(job.bindToken)
  };
}

function getGroupCommandRestrictionMessage_(command) {
  if (command === 'bind') {
    return '個人綁定請私訊 Bot 執行，避免授權連結曝光。';
  }
  if (command === 'reauthorize') {
    return '個人重新授權請私訊 Bot 執行。';
  }
  if (command === 'unbind') {
    return '個人解除綁定請私訊 Bot 執行。';
  }
  if (
    ['pendingApproval', 'approve', 'reject', 'confirmApproveAll', 'confirmRejectAll']
      .indexOf(command) >= 0
  ) {
    return '管理指令請私訊 Bot 執行。';
  }
  if (command === 'records') {
    return '紀錄查詢請私訊 Bot 執行。';
  }
  if (command === 'groupRecords') {
    return '群組完整紀錄請私訊 Bot 執行。';
  }
  if (command === 'quota' || command === 'groupQuota') {
    return '容量資訊屬於個人 Google Drive，請私訊 Bot 輸入「容量」查詢。';
  }
  return null;
}

function getApprovalCommandArgument_(job) {
  var rawText = String(job.rawText || '').trim();
  return rawText.replace(/^(核准|拒絕)(?:\s+)?/u, '').trim().toUpperCase();
}

function getApprovalConfirmationCommandArgument_(job) {
  var rawText = String(job.rawText || '').trim();
  return rawText
    .replace(/^確認核准全部(?:\s+)?/u, '')
    .replace(/^確認拒絕全部(?:\s+)?/u, '')
    .trim()
    .toUpperCase();
}

function formatApprovalBatchResult_(approvalStatus, result) {
  var action = approvalStatus === USER_APPROVAL_STATUS_.APPROVED ? '核准' : '拒絕';
  return action + '批次處理完成：成功 ' + result.succeeded + ' 筆，略過 ' +
    result.skipped + ' 筆，失敗 ' + result.failed + ' 筆。';
}

function bindGroup_(job, ownerLineUserHash) {
  if (!job.groupIdHash) {
    return { replyMessage: '「綁定群組」只能在一般 LINE 群組內使用。' };
  }
  var ownerRecord = findUserByHash_(ownerLineUserHash);
  var owner = findEnabledUserByHash_(ownerLineUserHash);
  if (!owner) {
    return {
      replyMessage: ownerRecord && getUserApprovalStatus_(ownerRecord) === USER_APPROVAL_STATUS_.PENDING
        ? '你的帳號尚未審核通過，請等待管理者核准。'
        : '請先私訊 Bot 完成 Google 綁定，再回群組輸入「綁定群組」。'
    };
  }
  var groupIdHash = job.groupIdHash;
  var existing = findEnabledGroupByHash_(groupIdHash);
  if (existing && existing.OwnerLineUserHash !== ownerLineUserHash) {
    return { replyMessage: '此群組已有其他備份擁有者，請先由原擁有者解除群組。' };
  }
  var accessToken = getUserAccessToken_(ownerLineUserHash);
  var groupName = existing && existing.GroupName
    ? existing.GroupName
    : sanitizeDisplayNameForSheet_(job.groupDisplayName || '未命名群組', '未命名群組');
  var folderId = createGroupBackupFolder_(accessToken, owner.GroupFolderId, groupName, groupIdHash);
  upsertGroup_({
    groupIdHash: groupIdHash,
    ownerLineUserHash: ownerLineUserHash,
    groupName: groupName,
    folderId: folderId,
    sheetId: owner.SheetId
  });
  return { replyMessage: '群組綁定完成。之後的附件會存入目前擁有者的 Google Drive。' };
}

function unbindGroup_(job, ownerLineUserHash) {
  if (!job.groupIdHash) {
    return { replyMessage: '「解除群組」只能在一般 LINE 群組內使用。' };
  }
  var groupIdHash = job.groupIdHash;
  var group = findEnabledGroupByHash_(groupIdHash);
  if (!group) {
    return { replyMessage: '此群組尚未綁定。' };
  }
  if (!isGroupManager_(group, ownerLineUserHash)) {
    return { replyMessage: '只有群組備份擁有者可以操作此指令。' };
  }
  disableGroup_(groupIdHash, null);
  return { replyMessage: '已解除群組備份；既有 Drive 檔案不會刪除。' };
}

function isGroupManager_(group, actorLineUserHash) {
  return Boolean(
    group &&
    typeof actorLineUserHash === 'string' &&
    (group.OwnerLineUserHash === actorLineUserHash || isAdminLineUserHash_(actorLineUserHash))
  );
}

function canGroupMemberSubmitBackup_(group, ownerUser) {
  return Boolean(group && isApprovedEnabledUser_(ownerUser));
}

function getGroupStatusMessage_(group) {
  return group ? '此群組已綁定' : '此群組尚未綁定';
}

function resolveBackupContext_(job) {
  if (!job.lineUserHash) {
    throw createAppError_('LINE_USER_ID_MISSING', false, 'LINE 未提供傳送者識別，無法備份。');
  }
  var senderHash = job.lineUserHash;
  if (job.groupIdHash) {
    var group = findEnabledGroupByHash_(job.groupIdHash);
    if (!group) {
      throw createAppError_('GROUP_NOT_BOUND', false, '此群組尚未指定備份擁有者。');
    }
    var ownerRecord = findUserByHash_(group.OwnerLineUserHash);
    var owner = findEnabledUserByHash_(group.OwnerLineUserHash);
    if (!canGroupMemberSubmitBackup_(group, owner)) {
      throw createAppError_(
        ownerRecord && getUserApprovalStatus_(ownerRecord) === USER_APPROVAL_STATUS_.PENDING
          ? 'GROUP_OWNER_NOT_APPROVED'
          : 'GROUP_OWNER_NOT_BOUND',
        false,
        ownerRecord && getUserApprovalStatus_(ownerRecord) === USER_APPROVAL_STATUS_.PENDING
          ? '群組備份擁有者尚未審核通過。'
          : '群組備份擁有者目前未綁定 Google 帳號。'
      );
    }
    return {
      ownerHash: group.OwnerLineUserHash,
      senderHash: senderHash,
      baseFolderId: group.FolderId,
      sheetId: owner.SheetId,
      groupName: group.GroupName,
      groupHash: job.groupIdHash,
      sourceType: '群組'
    };
  }
  var user = findUserByHash_(senderHash);
  if (!user) {
    throw createAppError_('USER_NOT_BOUND', false, '尚未綁定 Google 帳號，請先輸入「綁定 邀請碼」。');
  }
  if (!isApprovedEnabledUser_(user)) {
    throw createAppError_('USER_NOT_APPROVED', false, '你的帳號尚未審核通過，請等待管理者核准。');
  }
  return {
    ownerHash: senderHash,
    senderHash: senderHash,
    baseFolderId: user.PersonalFolderId,
    sheetId: user.SheetId,
    groupName: '',
    groupHash: '',
    sourceType: '個人'
  };
}

function getBackupSuccessReplyMessage_(job) {
  if (job.command === 'note') {
    return '✅ 筆記已備份。';
  }
  // 群組附件預設不回覆，避免在群組中洗版。
  if (job.groupIdHash) {
    return null;
  }
  var messages = {
    text: '✅ 文字已備份',
    image: '✅ 圖片已備份',
    video: '✅ 影片已備份',
    audio: '✅ 音訊已備份'
  };
  if (messages[job.messageType]) {
    return messages[job.messageType];
  }
  if (job.messageType === 'file') {
    return '✅ 檔案已備份：' + sanitizeFileName_(job.fileName, '檔案');
  }
  return null;
}

function createBackupSuccessResult_(job, driveFileId) {
  var replyMessage = getBackupSuccessReplyMessage_(job);
  var result = {};
  if (driveFileId) {
    result.driveFileId = driveFileId;
  }
  if (replyMessage) {
    result.replyMessage = replyMessage;
    result.backupSuccessReply = true;
  }
  return result;
}

function backupMessage_(job) {
  var context = resolveBackupContext_(job);
  var accessToken = getUserAccessToken_(context.ownerHash);
  var baseRecord = {
    messageTimestamp: job.timestamp,
    sourceType: context.sourceType,
    groupName: context.groupName,
    groupHash: context.groupHash,
    senderHash: context.senderHash,
    senderDisplayName: sanitizeDisplayNameForSheet_(
      job.senderDisplayName || (context.senderHash ? 'user_' + context.senderHash.slice(0, 8) : 'unknown_user'),
      'unknown_user'
    ),
    messageType: job.messageType,
    originalFileName: job.fileName || '',
    rawText: job.rawText || '',
    urls: extractUrls_(job.rawText || ''),
    tags: extractTags_(job.rawText || ''),
    webhookEventId: job.webhookEventId,
    messageId: job.messageId,
    status: '完成',
    errorMessage: ''
  };
  if (job.messageType === 'text') {
    touchJobLease_(job.webhookEventId);
    appendBackupRecord_(accessToken, context.sheetId, baseRecord);
    touchJobLease_(job.webhookEventId);
    return createBackupSuccessResult_(job, null);
  }
  if (job.rejectionCode === 'FILE_TOO_LARGE') {
    baseRecord.status = '拒絕';
    baseRecord.errorMessage = '附件超過允許的單檔大小。';
    touchJobLease_(job.webhookEventId);
    appendBackupRecord_(accessToken, context.sheetId, baseRecord);
    touchJobLease_(job.webhookEventId);
    return {
      jobStatus: 'REJECTED',
      errorCode: 'FILE_TOO_LARGE',
      safeMessage: baseRecord.errorMessage,
      replyMessage: baseRecord.errorMessage
    };
  }
  var existingJob = findJobByWebhookId_(job.webhookEventId);
  var driveFile = existingJob && existingJob.DriveFileId
    ? {
        id: String(existingJob.DriveFileId),
        webViewLink: 'https://drive.google.com/open?id=' + encodeURIComponent(String(existingJob.DriveFileId))
      }
    : null;
  try {
    if (!driveFile) {
      touchJobLease_(job.webhookEventId);
      var targetFolderId = ensureDatedTypeFolder_(
        accessToken,
        context.baseFolderId,
        job.timestamp,
        job.messageType
      );
      var eventKey = createDriveEventKey_(job.webhookEventId);
      driveFile = findUploadedDriveFileByEventKey_(accessToken, targetFolderId, eventKey);
      if (!driveFile) {
        var content = downloadLineContent_(job.messageId);
        touchJobLease_(job.webhookEventId);
        var fileName = createBackupFileName_(job, content.contentType);
        driveFile = uploadBlobToDrive_(
          accessToken,
          targetFolderId,
          fileName,
          content.contentType,
          content.blob.setName(fileName),
          eventKey
        );
      }
      recordJobDriveFile_(job.webhookEventId, driveFile.id);
    }
    baseRecord.driveFileId = driveFile.id;
    baseRecord.driveLink = driveFile.webViewLink;
    touchJobLease_(job.webhookEventId);
    appendBackupRecord_(accessToken, context.sheetId, baseRecord);
    touchJobLease_(job.webhookEventId);
    return createBackupSuccessResult_(job, driveFile.id);
  } catch (error) {
    if (isAppError_(error) && error.appCode === 'FILE_TOO_LARGE') {
      baseRecord.status = '拒絕';
      baseRecord.errorMessage = error.safeMessage;
      touchJobLease_(job.webhookEventId);
      appendBackupRecord_(accessToken, context.sheetId, baseRecord);
      touchJobLease_(job.webhookEventId);
      return {
        jobStatus: 'REJECTED',
        errorCode: error.appCode,
        safeMessage: error.safeMessage,
        replyMessage: error.safeMessage
      };
    }
    throw error;
  }
}

function processUnsend_(job) {
  var originalJob = markJobUnsent_(job.messageId);
  if (!originalJob) {
    return {};
  }
  try {
    var context = resolveBackupContext_(job);
    var accessToken = getUserAccessToken_(context.ownerHash);
    markBackupRecordUnsent_(accessToken, context.sheetId, job.messageId);
    if (shouldDeleteDriveFileOnUnsend_() && originalJob.DriveFileId) {
      deleteDriveFile_(accessToken, String(originalJob.DriveFileId));
    }
  } catch (error) {
    var appError = isAppError_(error) ? error : createAppError_('UNSEND_UPDATE_FAILED', true, '無法更新收回狀態。');
    recordSafeError_('unsend', appError.appCode, appError.safeMessage, job.webhookEventId);
  }
  return {};
}
