var MANUAL_REPLAY_REASON_ = 'MANUAL_GROUP_REPLAY';
var REPLAY_GROUP_SAFE_CODE_PATTERN_ = /^g_[a-f0-9]{8}$/i;
var REPLAY_MESSAGE_ID_PATTERN_ = /^[A-Za-z0-9._:-]{1,128}$/;
var REPLAY_WEBHOOK_EVENT_ID_PATTERN_ = /^[A-Za-z0-9._:-]{1,128}$/;
var REPLAY_QUEUE_BATCH_SIZE_ = 20;
var REPLAY_DATE_ERROR_MESSAGE_ = '補備份格式不正確，請使用：\n補備份 今日\n補備份 2026-08-01\n補備份 2026-08-01 至 2026-08-10\n補備份 8月\n補備份 2026-08';
var REPLAY_HISTORY_LIMITATION_MESSAGE_ = '注意：補備份只能處理 LineBot 已收到過的訊息，無法抓取 Bot 加入前或系統未收到的 LINE 歷史紀錄。';
var REPLAY_ELIGIBLE_JOB_STATUSES_ = [
  'FAILED',
  'ERROR',
  'PENDING',
  'RETRYABLE',
  'PROCESSING_TIMEOUT',
  'RETRY_REQUESTED',
  'OAUTH_REAUTH_REQUIRED',
  'RETRY_REQUESTED_PENDING_REAUTH'
];

function normalizeReplayDriveFileId_(value) {
  var normalized = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,200}$/.test(normalized) ? normalized : '';
}

function createReplayDayRange_(year, month, day) {
  if (![year, month, day].every(function (value) { return Number.isInteger(value); })) {
    return null;
  }
  var startMilliseconds = buildTaipeiDateMilliseconds_(year, month, day);
  var actual = getTaipeiDateParts_(startMilliseconds);
  if (actual.year !== year || actual.month !== month || actual.day !== day) {
    return null;
  }
  var dateText = String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  return {
    startMilliseconds: startMilliseconds,
    endMilliseconds: startMilliseconds + 86400000,
    label: dateText.replace(/-/g, '/'),
    startDate: dateText,
    endDate: dateText
  };
}

function parseReplayIsoDate_(value) {
  var match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? createReplayDayRange_(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

function parseManualReplayDateRange_(value, nowMilliseconds) {
  var text = String(value || '').trim();
  var now = Number.isSafeInteger(nowMilliseconds) ? nowMilliseconds : Date.now();
  var today = getTaipeiDateParts_(now);
  if (text === '今日') {
    return createReplayDayRange_(today.year, today.month, today.day);
  }
  var dateRangeMatch = text.match(/^(\d{4}-\d{2}-\d{2})\s*至\s*(\d{4}-\d{2}-\d{2})$/);
  if (dateRangeMatch) {
    var rangeStart = parseReplayIsoDate_(dateRangeMatch[1]);
    var rangeEnd = parseReplayIsoDate_(dateRangeMatch[2]);
    if (!rangeStart || !rangeEnd || rangeEnd.startMilliseconds < rangeStart.startMilliseconds) {
      return null;
    }
    return {
      startMilliseconds: rangeStart.startMilliseconds,
      endMilliseconds: rangeEnd.endMilliseconds,
      label: rangeStart.label + ' ~ ' + rangeEnd.label,
      startDate: rangeStart.startDate,
      endDate: rangeEnd.endDate
    };
  }
  var singleDate = parseReplayIsoDate_(text);
  if (singleDate) {
    return singleDate;
  }
  var monthMatch = text.match(/^(\d{1,2})月$/);
  if (monthMatch) {
    return buildGroupMonthRange_(today.year, Number(monthMatch[1]));
  }
  var yearMonthMatch = text.match(/^(\d{4})年(\d{1,2})月$/);
  if (yearMonthMatch) {
    return buildGroupMonthRange_(Number(yearMonthMatch[1]), Number(yearMonthMatch[2]));
  }
  if (/^\d{4}-\d{2}$/.test(text)) {
    return buildGroupMonthRange_(Number(text.slice(0, 4)), Number(text.slice(5, 7)));
  }
  return null;
}

function parseManualReplayQuery_(job) {
  var prefix = job.command === 'manualGroupReplay' ? '群組補備份' : '補備份';
  var rawText = String(job.rawText || '').trim();
  var argument = rawText.indexOf(prefix) === 0 ? rawText.slice(prefix.length).trim() : '';
  var tokens = argument ? argument.split(/\s+/).filter(function (token) { return token; }) : [];
  var safeCode = '';
  tokens = tokens.filter(function (token) {
    if (REPLAY_GROUP_SAFE_CODE_PATTERN_.test(token)) {
      safeCode = token.toLowerCase();
      return false;
    }
    return true;
  });
  var queryText = tokens.join(' ');
  var nowMilliseconds = Date.now();
  var today = getTaipeiDateParts_(nowMilliseconds);
  // 私訊不帶日期時，預設補備份本月；群組內仍要求明確日期，避免誤補過大範圍。
  var query = queryText
    ? parseManualReplayDateRange_(queryText, nowMilliseconds)
    : job.command === 'manualGroupReplay'
      ? buildGroupMonthRange_(today.year, today.month)
      : null;
  if (!query) {
    throw createAppError_('REPLAY_DATE_INVALID', false, REPLAY_DATE_ERROR_MESSAGE_);
  }
  return { query: query, safeCode: safeCode };
}

function getReplayGroupListReply_(groups) {
  var lines = ['可補備份的群組：'];
  groups.forEach(function (group) {
    lines.push(getGroupQuerySafeCode_(group.GroupIdHash) + '：' + sanitizeGroupSummaryText_(group.GroupName, 80));
  });
  lines.push('', '請在 10 分鐘內重新輸入：群組補備份 YYYY-MM g_xxxxxxxx');
  return lines.join('\n');
}

function resolveManualReplayGroup_(lineUserHash, groupIdHash, safeCode) {
  var isAdmin = isAdminLineUserHash_(lineUserHash);
  if (groupIdHash) {
    var group = findEnabledGroupByHash_(groupIdHash);
    if (!group) {
      throw createAppError_('REPLAY_GROUP_NOT_BOUND', false, '本群組尚未綁定，無法補備份。');
    }
    if (!isGroupManager_(group, lineUserHash)) {
      throw createAppError_('REPLAY_GROUP_OWNER_ONLY', false, '只有群組備份擁有者可以執行補備份。');
    }
    if (safeCode && getGroupQuerySafeCode_(group.GroupIdHash) !== safeCode) {
      throw createAppError_('REPLAY_GROUP_NOT_FOUND', false, '找不到可補備份的群組。');
    }
    return group;
  }
  var groups = getSheetRecords_('Groups').filter(function (record) {
    return isEnabledUserValue_(record.Enabled) && (isAdmin || record.OwnerLineUserHash === lineUserHash);
  });
  if (safeCode) {
    groups = groups.filter(function (record) {
      return getGroupQuerySafeCode_(record.GroupIdHash) === safeCode;
    });
  }
  if (groups.length === 0) {
    throw createAppError_('REPLAY_NO_GROUP', false, '你目前沒有可補備份的群組。');
  }
  if (groups.length > 1) {
    throw createAppError_('REPLAY_GROUP_SELECTION_REQUIRED', false, getReplayGroupListReply_(groups));
  }
  return groups[0];
}

/** 說明指令只在使用者確實有可操作群組時顯示私訊補備份說明。 */
function hasManualReplayGroupAccess_(lineUserHash) {
  if (typeof lineUserHash !== 'string' || !/^[a-f0-9]{64}$/i.test(lineUserHash)) {
    return false;
  }
  try {
    var groups = getSheetRecords_('Groups');
    if (isAdminLineUserHash_(lineUserHash)) {
      return groups.some(function (record) {
        return isEnabledUserValue_(record.Enabled);
      });
    }
    return groups.some(function (record) {
      return isEnabledUserValue_(record.Enabled) && record.OwnerLineUserHash === lineUserHash;
    });
  } catch (error) {
    // 說明指令不得因管理 Sheet 尚未初始化而失敗；正式補備份仍會在執行時嚴格驗證。
    return false;
  }
}

function normalizeReplayMessageType_(value) {
  var normalized = String(value || '').trim().toLowerCase();
  var mapping = {
    text: 'text',
    image: 'image',
    video: 'video',
    audio: 'audio',
    file: 'file',
    '文字': 'text',
    '圖片': 'image',
    '影片': 'video',
    '音訊': 'audio',
    '檔案': 'file'
  };
  return mapping[normalized] || null;
}

function isReplayJobStatusEligible_(jobRecord) {
  if (!jobRecord) {
    return true;
  }
  var status = String(jobRecord.Status || '').toUpperCase();
  if (['COMPLETED', 'REJECTED', 'UNSENT'].indexOf(status) >= 0) {
    return false;
  }
  if (status === 'PROCESSING') {
    return !isJobLeaseActive_(jobRecord, Date.now());
  }
  return REPLAY_ELIGIBLE_JOB_STATUSES_.indexOf(status) >= 0;
}

function isReplayRecordCompleted_(record, jobRecord) {
  return isSuccessfulGroupRecord_(record) || Boolean(jobRecord && String(jobRecord.Status || '').toUpperCase() === 'COMPLETED');
}

function getReplayJobByRecord_(record, jobsByWebhookId, jobsByMessageId) {
  var eventId = String(getGroupQueryField_(record, 'webhookEventId') || '').trim();
  var messageId = String(getGroupQueryField_(record, 'messageId') || '').trim();
  return (eventId && jobsByWebhookId[eventId]) || (messageId && jobsByMessageId[messageId]) || null;
}

function createSyntheticReplayEventId_(messageId) {
  return 'replay-' + hashIdentifier_(messageId).slice(0, 48);
}

function buildReplayQueueJob_(record, group, jobRecord, fallbackGroupHash) {
  var messageId = String(getGroupQueryField_(record, 'messageId') || '').trim();
  if (!REPLAY_MESSAGE_ID_PATTERN_.test(messageId)) {
    return null;
  }
  var eventId = String(getGroupQueryField_(record, 'webhookEventId') || '').trim();
  if (jobRecord && REPLAY_WEBHOOK_EVENT_ID_PATTERN_.test(String(jobRecord.WebhookEventId || ''))) {
    eventId = String(jobRecord.WebhookEventId);
  }
  if (!REPLAY_WEBHOOK_EVENT_ID_PATTERN_.test(eventId)) {
    eventId = createSyntheticReplayEventId_(messageId);
  }
  var senderHash = String(getGroupQueryField_(record, '傳送者識別') || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(senderHash)) {
    return null;
  }
  var messageType = normalizeReplayMessageType_(getGroupQueryField_(record, '訊息類型'));
  if (!messageType) {
    return null;
  }
  var timestamp = parseStoredDateMilliseconds_(getGroupQueryField_(record, 'LINE 訊息時間'));
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  var rawText = messageType === 'text'
    ? String(getGroupQueryField_(record, '文字內容') || '').slice(0, 5000)
    : null;
  var isNote = messageType === 'text' && /^#筆記(?:\s|$)/u.test(rawText.trim());
  var originalFileName = messageType === 'file'
    ? String(getGroupQueryField_(record, '原始檔名') || '').slice(0, 255)
    : null;
  return {
    schemaVersion: 1,
    eventType: 'message',
    webhookEventId: eventId,
    messageId: messageId,
    messageType: messageType,
    lineUserHash: senderHash,
    groupIdHash: fallbackGroupHash || (group && group.GroupIdHash) || null,
    senderDisplayName: sanitizeDisplayNameForSheet_(getGroupQueryField_(record, '傳送者名稱'), 'unknown_user'),
    groupDisplayName: sanitizeDisplayNameForSheet_(
      getGroupQueryField_(record, '群組名稱') || (group && group.GroupName),
      group && group.GroupName ? group.GroupName : ''
    ) || null,
    replyToken: null,
    timestamp: timestamp,
    fileName: originalFileName,
    fileSize: null,
    rawText: rawText,
    command: isNote ? 'note' : null,
    shouldSave: true,
    rejectionCode: null,
    bindToken: null
  };
}

function buildReplayQueueJobFromJobRecord_(jobRecord, group) {
  if (!jobRecord || String(jobRecord.MessageType || '').toLowerCase() === 'text') {
    // 文字／#筆記內容不會寫入管理 Jobs；沒有使用者 Sheet 紀錄時無法安全重建原文。
    return null;
  }
  var record = {
    '群組識別': jobRecord.GroupIdHash || '',
    '群組名稱': jobRecord.GroupDisplayName || (group && group.GroupName) || '',
    '傳送者識別': jobRecord.LineUserHash || '',
    '傳送者名稱': jobRecord.SenderDisplayName || '',
    '訊息類型': jobRecord.MessageType || '',
    '原始檔名': jobRecord.OriginalFileName || '',
    '文字內容': '',
    'LINE 訊息時間': jobRecord.LineMessageTime || '',
    'webhookEventId': jobRecord.WebhookEventId || '',
    'messageId': jobRecord.MessageId || ''
  };
  return buildReplayQueueJob_(record, group, jobRecord, group ? group.GroupIdHash : '');
}

function collectManualReplayCandidates_(group, owner, query) {
  var accessToken = getUserAccessToken_(group.OwnerLineUserHash);
  var sheetData = readBackupRecordsForGroupQuery_(accessToken, owner.SheetId);
  var groups = getSheetRecords_('Groups');
  var ownerGroupMatches = groups.filter(function (record) {
    return record.OwnerLineUserHash === group.OwnerLineUserHash &&
      String(record.GroupName || '') === String(group.GroupName || '');
  });
  var canFallback = ownerGroupMatches.length === 1;
  var jobs = getSheetRecords_('Jobs');
  var jobsByWebhookId = {};
  var jobsByMessageId = {};
  jobs.forEach(function (job) {
    if (job.WebhookEventId) {
      jobsByWebhookId[String(job.WebhookEventId)] = job;
    }
    if (job.MessageId) {
      jobsByMessageId[String(job.MessageId)] = job;
    }
  });
  var result = {
    candidates: [],
    skippedCompleted: 0,
    skippedUnavailable: 0,
    skippedAmbiguous: 0
  };
  var seenJobKeys = {};
  sheetData.records.forEach(function (record) {
    if (!isGroupRecordSource_(record)) {
      return;
    }
    var timestamp = parseStoredDateMilliseconds_(getGroupQueryField_(record, 'LINE 訊息時間'));
    if (!Number.isFinite(timestamp) || timestamp < query.startMilliseconds || timestamp >= query.endMilliseconds) {
      return;
    }
    var recordGroupHash = String(getGroupQueryField_(record, '群組識別') || '').trim();
    var matchesGroup = recordGroupHash && recordGroupHash === group.GroupIdHash;
    var legacyMatches = !recordGroupHash && canFallback && isLegacyGroupRecordForGroup_(record, group);
    if (!matchesGroup && !legacyMatches) {
      if (!recordGroupHash && isLegacyGroupRecordForGroup_(record, group)) {
        result.skippedAmbiguous += 1;
      }
      return;
    }
    var recordEventKey = String(getGroupQueryField_(record, 'webhookEventId') || '').trim();
    var recordMessageKey = String(getGroupQueryField_(record, 'messageId') || '').trim();
    if (recordEventKey) {
      seenJobKeys['event:' + recordEventKey] = true;
    }
    if (recordMessageKey) {
      seenJobKeys['message:' + recordMessageKey] = true;
    }
    var jobRecord = getReplayJobByRecord_(record, jobsByWebhookId, jobsByMessageId);
    if (isReplayRecordCompleted_(record, jobRecord)) {
      result.skippedCompleted += 1;
      return;
    }
    if (jobRecord && !isReplayJobStatusEligible_(jobRecord)) {
      result.skippedUnavailable += 1;
      return;
    }
    var queueJob = buildReplayQueueJob_(record, group, jobRecord, legacyMatches ? group.GroupIdHash : recordGroupHash);
    if (!queueJob) {
      result.skippedUnavailable += 1;
      return;
    }
    result.candidates.push({
      queueJob: queueJob,
      jobRecord: jobRecord,
      driveFileId: normalizeReplayDriveFileId_(getGroupQueryField_(record, 'Drive File ID'))
    });
  });
  // OAuth 失效可能發生在寫入使用者 Sheet 之前；此時只剩 Jobs metadata，仍須保留附件補救機會。
  jobs.forEach(function (jobRecord) {
    if (String(jobRecord.OwnerLineUserHash || '') !== String(group.OwnerLineUserHash || '') ||
        String(jobRecord.GroupIdHash || '') !== String(group.GroupIdHash || '') ||
        !isGroupRecordSource_({ '來源類型': jobRecord.SourceType || '' })) {
      return;
    }
    if (!isReplayJobStatusEligible_(jobRecord)) {
      if (['COMPLETED', 'REJECTED', 'UNSENT'].indexOf(String(jobRecord.Status || '').toUpperCase()) >= 0) {
        result.skippedCompleted += 1;
      } else {
        result.skippedUnavailable += 1;
      }
      return;
    }
    var jobTimestamp = parseStoredDateMilliseconds_(jobRecord.LineMessageTime);
    if (!Number.isFinite(jobTimestamp) || jobTimestamp < query.startMilliseconds || jobTimestamp >= query.endMilliseconds) {
      return;
    }
    var eventKey = jobRecord.WebhookEventId ? 'event:' + String(jobRecord.WebhookEventId) : '';
    var messageKey = jobRecord.MessageId ? 'message:' + String(jobRecord.MessageId) : '';
    if ((eventKey && seenJobKeys[eventKey]) || (messageKey && seenJobKeys[messageKey])) {
      return;
    }
    var queueJob = buildReplayQueueJobFromJobRecord_(jobRecord, group);
    if (!queueJob) {
      result.skippedUnavailable += 1;
      return;
    }
    result.candidates.push({
      queueJob: queueJob,
      jobRecord: jobRecord,
      driveFileId: normalizeReplayDriveFileId_(jobRecord.DriveFileId)
    });
    if (eventKey) {
      seenJobKeys[eventKey] = true;
    }
    if (messageKey) {
      seenJobKeys[messageKey] = true;
    }
  });
  return result;
}

function collectPersonalReplayCandidates_(lineUserHash, query) {
  var result = {
    candidates: [],
    skippedCompleted: 0,
    skippedUnavailable: 0
  };
  var jobs = getSheetRecords_('Jobs');
  jobs.forEach(function (jobRecord) {
    if (String(jobRecord.SourceType || '') !== 'private' ||
        String(jobRecord.LineUserHash || '') !== lineUserHash ||
        String(jobRecord.OwnerLineUserHash || '') !== lineUserHash) {
      return;
    }
    var timestamp = parseStoredDateMilliseconds_(jobRecord.LineMessageTime);
    if (!Number.isFinite(timestamp) || timestamp < query.startMilliseconds || timestamp >= query.endMilliseconds) {
      return;
    }
    var status = String(jobRecord.Status || '').toUpperCase();
    if (['COMPLETED', 'REJECTED', 'UNSENT'].indexOf(status) >= 0) {
      result.skippedCompleted += 1;
      return;
    }
    if (!isReplayJobStatusEligible_(jobRecord)) {
      result.skippedUnavailable += 1;
      return;
    }
    var queueJob = buildReplayQueueJobFromJobRecord_(jobRecord, null);
    if (!queueJob) {
      result.skippedUnavailable += 1;
      return;
    }
    result.candidates.push({
      queueJob: queueJob,
      jobRecord: jobRecord,
      driveFileId: normalizeReplayDriveFileId_(jobRecord.DriveFileId)
    });
  });
  return result;
}

function requestPersonalReplay_(lineUserHash, query) {
  var owner = findEnabledUserByHash_(lineUserHash);
  if (!owner || !owner.SheetId) {
    return {
      available: 0,
      skippedCompleted: 0,
      skippedUnavailable: 0,
      failed: 0,
      reply: getOAuthNotBoundMessage_()
    };
  }
  var collected = collectPersonalReplayCandidates_(lineUserHash, query);
  if (collected.candidates.length === 0) {
    return {
      available: 0,
      skippedCompleted: collected.skippedCompleted,
      skippedUnavailable: collected.skippedUnavailable,
      failed: 0,
      reply: '查無可補備份項目。\n\n可能原因：\n1. 此期間沒有授權失效或未完成項目。\n2. 相關項目已成功備份。\n3. LineBot 當時未收到該訊息，無法回溯 LINE 歷史紀錄。'
    };
  }
  var requestable = [];
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    ensureAdminSheets_();
    var nowText = getTaipeiNow_();
    collected.candidates.forEach(function (candidate) {
      if (markReplayJobRequestedWithoutLock_(candidate, lineUserHash, nowText)) {
        requestable.push(candidate.queueJob);
      }
    });
  } finally {
    lock.releaseLock();
  }
  if (requestable.length === 0) {
    return {
      available: 0,
      skippedCompleted: collected.skippedCompleted,
      skippedUnavailable: collected.skippedUnavailable + collected.candidates.length,
      failed: 0,
      reply: '查無可補備份項目。'
    };
  }
  var failed = 0;
  try {
    enqueueReplayJobsToWorker_(requestable);
    markReplayBatchEnqueued_(requestable);
  } catch (error) {
    failed = requestable.length;
    markReplayBatchFailed_(requestable, isAppError_(error) ? error.appCode : 'REPLAY_QUEUE_ENQUEUE_FAILED');
  }
  var available = requestable.length - failed;
  return {
    available: available,
    skippedCompleted: collected.skippedCompleted,
    skippedUnavailable: collected.skippedUnavailable,
    failed: failed,
    reply: [
      '🔁 個人補備份任務已建立',
      '',
      '範圍：' + query.label,
      '可補項目：' + available + ' 筆',
      '略過已完成：' + collected.skippedCompleted + ' 筆',
      '略過不可補：' + collected.skippedUnavailable + ' 筆',
      '建立失敗：' + failed + ' 筆',
      '',
      REPLAY_HISTORY_LIMITATION_MESSAGE_
    ].join('\n')
  };
}

function getReplayRequestByEventId_(eventId) {
  return getSheetRecords_('ReplayRequests').find(function (record) {
    return String(record.OriginalWebhookEventId || '') === String(eventId || '') &&
      ['PENDING', 'ENQUEUED'].indexOf(String(record.Status || '').toUpperCase()) >= 0;
  }) || null;
}

function markReplayJobRequestedWithoutLock_(candidate, actorLineUserHash, nowText) {
  var queueJob = candidate.queueJob;
  var existing = candidate.jobRecord || findJobByWebhookId_(queueJob.webhookEventId) || findJobByMessageId_(queueJob.messageId);
  if (existing && ['COMPLETED', 'REJECTED', 'UNSENT'].indexOf(String(existing.Status || '').toUpperCase()) >= 0) {
    return false;
  }
  var replayRequest = getReplayRequestByEventId_(queueJob.webhookEventId);
  if (replayRequest) {
    var replayStatus = String(replayRequest.Status || '').toUpperCase();
    if (replayStatus === 'PENDING') {
      return false;
    }
    // 已送入 Queue 的項目只有在原工作已 FAILED 或 PROCESSING 租約已過期時才能再次要求；
    // 避免管理者連續輸入指令造成平行補備份工作。
    var existingStatus = String(existing && existing.Status || '').toUpperCase();
    var canRetryEnqueued = existingStatus === 'FAILED' ||
      (existingStatus === 'PROCESSING' && !isJobLeaseActive_(existing, Date.now()));
    if (replayStatus === 'ENQUEUED' && !canRetryEnqueued) {
      return false;
    }
  }
  if (existing) {
    getAdminSheet_('Jobs').getRange(existing._row, 3, 1, 8).setValues([[
      'RETRY_REQUESTED',
      Number(existing.RetryCount) || 0,
      '',
      existing.DriveFileId || '',
      MANUAL_REPLAY_REASON_,
      '等待補備份佇列處理。',
      existing.CreatedAt || nowText,
      nowText
    ]]);
  } else {
    appendAdminRow_('Jobs', [
      queueJob.webhookEventId,
      queueJob.messageId,
      'RETRY_REQUESTED',
      0,
      '',
      candidate.driveFileId || '',
      MANUAL_REPLAY_REASON_,
      '等待補備份佇列處理。',
      nowText,
      nowText
    ]);
  }
  appendAdminRow_('ReplayRequests', [
    queueJob.webhookEventId,
    queueJob.messageId,
    nowText,
    actorLineUserHash,
    MANUAL_REPLAY_REASON_,
    'PENDING',
    nowText,
    nowText,
    ''
  ]);
  return true;
}

function markReplayBatchFailed_(jobs, errorCode) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var nowText = getTaipeiNow_();
    jobs.forEach(function (queueJob) {
      var existing = findJobByWebhookId_(queueJob.webhookEventId);
      if (existing) {
        getAdminSheet_('Jobs').getRange(existing._row, 3, 1, 8).setValues([[
          'FAILED', Number(existing.RetryCount) || 0, '', existing.DriveFileId || '',
          errorCode, '補備份佇列無法建立。', existing.CreatedAt || nowText, nowText
        ]]);
      }
      var replayRequest = getSheetRecords_('ReplayRequests').find(function (record) {
        return record.OriginalWebhookEventId === queueJob.webhookEventId && record.Status === 'PENDING';
      });
      if (replayRequest) {
        getAdminSheet_('ReplayRequests').getRange(replayRequest._row, 6, 1, 4).setValues([[
          'FAILED', nowText, nowText, errorCode
        ]]);
      }
    });
  } finally {
    lock.releaseLock();
  }
}

function markReplayBatchEnqueued_(jobs) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var nowText = getTaipeiNow_();
    var replayRequests = getSheetRecords_('ReplayRequests');
    jobs.forEach(function (queueJob) {
      var replayRequest = replayRequests.find(function (record) {
        return String(record.OriginalWebhookEventId || '') === queueJob.webhookEventId &&
          String(record.Status || '').toUpperCase() === 'PENDING';
      });
      if (replayRequest) {
        getAdminSheet_('ReplayRequests').getRange(replayRequest._row, 6, 1, 4).setValues([[
          'ENQUEUED', replayRequest.CreatedAt || nowText, nowText, ''
        ]]);
      }
    });
  } finally {
    lock.releaseLock();
  }
}

function enqueueReplayJobsToWorker_(jobs) {
  var endpoint = getRequiredProperty_(APP_CONFIG_KEYS_.WORKER_REPLAY_ENDPOINT);
  if (!/^https:\/\/[^\s]{1,500}$/i.test(endpoint)) {
    throw createAppError_('REPLAY_ENDPOINT_INVALID', false, '補備份服務設定不正確。');
  }
  var sharedSecret = getRequiredProperty_(APP_CONFIG_KEYS_.WORKER_GAS_SHARED_SECRET);
  var accepted = 0;
  for (var offset = 0; offset < jobs.length; offset += REPLAY_QUEUE_BATCH_SIZE_) {
    var batch = jobs.slice(offset, offset + REPLAY_QUEUE_BATCH_SIZE_);
    var timestamp = Date.now();
    var nonce = Utilities.getUuid().replace(/-/g, '').toLowerCase();
    var payload = JSON.stringify({ jobs: batch });
    var envelope = {
      timestamp: timestamp,
      nonce: nonce,
      payload: payload,
      signature: computeWorkerEnvelopeSignature_(timestamp, nonce, payload, sharedSecret)
    };
    var response = UrlFetchApp.fetch(endpoint, {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      payload: JSON.stringify(envelope),
      muteHttpExceptions: true
    });
    var responseCode = response.getResponseCode();
    if (responseCode < 200 || responseCode >= 300) {
      throw createAppError_('REPLAY_QUEUE_ENQUEUE_FAILED', responseCode >= 500, '補備份佇列暫時無法建立。');
    }
    var result;
    try {
      result = JSON.parse(response.getContentText());
    } catch (error) {
      throw createAppError_('REPLAY_QUEUE_RESPONSE_INVALID', true, '補備份佇列回應格式不正確。');
    }
    if (!result || result.ok !== true || result.acceptedCount !== batch.length) {
      throw createAppError_('REPLAY_QUEUE_RESPONSE_INVALID', true, '補備份佇列回應格式不正確。');
    }
    accepted += batch.length;
  }
  return accepted;
}

function requestManualGroupReplay_(lineUserHash, group, query) {
  var owner = findEnabledUserByHash_(group.OwnerLineUserHash);
  if (!owner || !owner.SheetId) {
    return {
      available: 0,
      skippedCompleted: 0,
      skippedUnavailable: 0,
      failed: 0,
      reply: '本群組尚未綁定，無法補備份。'
    };
  }
  var collected = collectManualReplayCandidates_(group, owner, query);
  if (collected.candidates.length === 0) {
    return {
      available: 0,
      skippedCompleted: collected.skippedCompleted,
      skippedUnavailable: collected.skippedUnavailable + collected.skippedAmbiguous,
      failed: 0,
      reply: '查無可補備份項目。\n\n可能原因：\n1. 此期間沒有失敗或未完成項目。\n2. 相關項目已成功備份。\n3. LineBot 當時未收到該訊息，無法回溯 LINE 歷史紀錄。'
    };
  }
  var candidates = collected.candidates;
  var requestable = [];
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    ensureAdminSheets_();
    var nowText = getTaipeiNow_();
    candidates.forEach(function (candidate) {
      if (markReplayJobRequestedWithoutLock_(candidate, lineUserHash, nowText)) {
        requestable.push(candidate.queueJob);
      }
    });
  } finally {
    lock.releaseLock();
  }
  if (requestable.length === 0) {
    return {
      available: 0,
      skippedCompleted: collected.skippedCompleted,
      skippedUnavailable: collected.skippedUnavailable + candidates.length,
      failed: 0,
      reply: '查無可補備份項目。'
    };
  }
  var failed = 0;
  try {
    enqueueReplayJobsToWorker_(requestable);
    markReplayBatchEnqueued_(requestable);
  } catch (error) {
    failed = requestable.length;
    markReplayBatchFailed_(requestable, isAppError_(error) ? error.appCode : 'REPLAY_QUEUE_ENQUEUE_FAILED');
  }
  var available = requestable.length - failed;
  var lines = [
    '🔁 補備份任務已建立',
    '',
    '群組：' + sanitizeGroupSummaryText_(group.GroupName, 80),
    '範圍：' + query.label,
    '',
    '可補項目：' + available + ' 筆',
    '略過已完成：' + collected.skippedCompleted + ' 筆',
    '略過不可補：' + (collected.skippedUnavailable + collected.skippedAmbiguous) + ' 筆',
    '建立失敗：' + failed + ' 筆',
    '',
    REPLAY_HISTORY_LIMITATION_MESSAGE_
  ];
  return {
    available: available,
    skippedCompleted: collected.skippedCompleted,
    skippedUnavailable: collected.skippedUnavailable + collected.skippedAmbiguous,
    failed: failed,
    reply: lines.join('\n')
  };
}

function getManualGroupReplayReply_(job) {
  var parsed = parseManualReplayQuery_(job);
  var group = resolveManualReplayGroup_(job.lineUserHash, job.groupIdHash, parsed.safeCode);
  return requestManualGroupReplay_(job.lineUserHash, group, parsed.query).reply;
}

function getPersonalReplayReply_(job) {
  var parsed = parseManualReplayQuery_(job);
  return requestPersonalReplay_(job.lineUserHash, parsed.query).reply;
}
