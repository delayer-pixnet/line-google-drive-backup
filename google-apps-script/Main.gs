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
    return { replyMessage: getHelpMessage_() };
  }
  if (job.eventType === 'unfollow') {
    if (job.lineUserId) {
      unlinkGoogleAccount_(hashIdentifier_(job.lineUserId));
    }
    return {};
  }
  if (job.eventType === 'join') {
    return { replyMessage: 'Bot 已加入群組。請由預定的備份擁有者輸入「綁定群組」。' };
  }
  if (job.eventType === 'leave') {
    if (job.groupId) {
      disableGroup_(hashIdentifier_(job.groupId), null);
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

function getHelpMessage_() {
  return [
    '可用指令：',
    '綁定：自助申請 Google 帳號（需管理者審核）',
    '綁定 <邀請碼>：使用管理者邀請碼連結 Google 帳號',
    '狀態：查詢個人與群組綁定',
    '解除綁定：清除 OAuth Token',
    '綁定群組／解除群組：設定群組備份擁有者',
    '#筆記 <內容>：在群組保存文字',
    '說明：顯示本說明',
    '管理者指令：待審核、核准／拒絕 <編號[,編號]>、核准／拒絕 全部（需二次確認）'
  ].join('\n');
}

function processCommand_(job) {
  if (!job.lineUserId) {
    return { replyMessage: 'LINE 未提供傳送者識別，無法執行此指令。' };
  }
  var lineUserHash = hashIdentifier_(job.lineUserId);
  if (job.command === 'pendingApproval') {
    if (job.groupId) {
      return { replyMessage: '管理者審核指令請在私訊 Bot 中使用。' };
    }
    assertAdminUser_(lineUserHash);
    return { replyMessage: listPendingApprovalUsers_() };
  }
  if (job.command === 'approve' || job.command === 'reject') {
    if (job.groupId) {
      return { replyMessage: '管理者審核指令請在私訊 Bot 中使用。' };
    }
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
    if (job.groupId) {
      return { replyMessage: '管理者審核指令請在私訊 Bot 中使用。' };
    }
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
    return { replyMessage: getHelpMessage_() };
  }
  if (job.command === 'bind') {
    if (job.groupId) {
      return { replyMessage: '為避免綁定連結在群組曝光，請私訊 Bot 執行「綁定 <邀請碼>」。' };
    }
    var inviteCode = String(job.rawText || '').replace(/^綁定\s*/u, '').trim();
    if (!inviteCode) {
      if (!isSelfServiceBindingEnabled_()) {
        return { replyMessage: '請輸入「綁定 <邀請碼>」。邀請碼請向管理者取得。' };
      }
      var existingUser = findUserByHash_(lineUserHash);
      var existingStatus = getUserApprovalStatus_(existingUser);
      if (existingUser && existingUser.GoogleSubjectId && existingStatus === USER_APPROVAL_STATUS_.APPROVED) {
        return { replyMessage: '目前已完成 Google 綁定，請輸入「狀態」查詢。' };
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
    var groupStatus = job.groupId
      ? (findEnabledGroupByHash_(hashIdentifier_(job.groupId)) ? '此群組已綁定' : '此群組尚未綁定')
      : '目前是個人聊天室';
    return {
      replyMessage: userStatusMessage +
        '\n管理中的群組：' + ownedGroups.length + ' 個\n' + groupStatus
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
  if (!job.groupId) {
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
  var groupIdHash = hashIdentifier_(job.groupId);
  var existing = findEnabledGroupByHash_(groupIdHash);
  if (existing && existing.OwnerLineUserHash !== ownerLineUserHash) {
    return { replyMessage: '此群組已有其他備份擁有者，請先由原擁有者解除群組。' };
  }
  var accessToken = getUserAccessToken_(ownerLineUserHash);
  var groupName = getLineGroupName_(job.groupId);
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
  if (!job.groupId) {
    return { replyMessage: '「解除群組」只能在一般 LINE 群組內使用。' };
  }
  return {
    replyMessage: disableGroup_(hashIdentifier_(job.groupId), ownerLineUserHash)
      ? '已解除群組備份；既有 Drive 檔案不會刪除。'
      : '只有目前的群組備份擁有者可以解除，或此群組尚未綁定。'
  };
}

function resolveBackupContext_(job) {
  if (!job.lineUserId) {
    throw createAppError_('LINE_USER_ID_MISSING', false, 'LINE 未提供傳送者識別，無法備份。');
  }
  var senderHash = hashIdentifier_(job.lineUserId);
  if (job.groupId) {
    var senderRecord = findUserByHash_(senderHash);
    if (senderRecord && !isApprovedEnabledUser_(senderRecord)) {
      throw createAppError_('USER_NOT_APPROVED', false, '你的帳號尚未審核通過，請等待管理者核准。');
    }
    var group = findEnabledGroupByHash_(hashIdentifier_(job.groupId));
    if (!group) {
      throw createAppError_('GROUP_NOT_BOUND', false, '此群組尚未指定備份擁有者。');
    }
    var ownerRecord = findUserByHash_(group.OwnerLineUserHash);
    var owner = findEnabledUserByHash_(group.OwnerLineUserHash);
    if (!owner) {
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
    sourceType: '個人'
  };
}

function getBackupSuccessReplyMessage_(job) {
  if (job.command === 'note') {
    return '✅ 筆記已備份。';
  }
  // 群組附件預設不回覆，避免在群組中洗版。
  if (job.groupId) {
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
    senderHash: context.senderHash,
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
