function findJobByWebhookId_(webhookEventId) {
  return getSheetRecords_('Jobs').find(function (record) {
    return record.WebhookEventId === webhookEventId;
  }) || null;
}

function findJobByMessageId_(messageId) {
  return getSheetRecords_('Jobs').find(function (record) {
    return record.MessageId === messageId;
  }) || null;
}

function getNewJobLeaseExpiration_() {
  return new Date(Date.now() + getJobProcessingLeaseSeconds_() * 1000);
}

function isJobLeaseActive_(jobRecord, nowMilliseconds) {
  var leaseExpiresAt = parseStoredDateMilliseconds_(jobRecord.LeaseExpiresAt);
  return Number.isFinite(leaseExpiresAt) && leaseExpiresAt > nowMilliseconds;
}

var JOB_RETRY_AFTER_MIN_SECONDS_ = 30;
var JOB_RETRY_AFTER_MAX_SECONDS_ = 900;
var JOB_RETRY_AFTER_SAFETY_BUFFER_SECONDS_ = 5;

function getJobRetryAfterSeconds_(leaseExpiresAt, nowMilliseconds) {
  var leaseExpiresAtMilliseconds = parseStoredDateMilliseconds_(leaseExpiresAt);
  if (!Number.isFinite(leaseExpiresAtMilliseconds)) {
    return 60;
  }
  var remainingSeconds = Math.ceil(
    (leaseExpiresAtMilliseconds - nowMilliseconds) / 1000
  );
  return Math.min(
    JOB_RETRY_AFTER_MAX_SECONDS_,
    Math.max(
      JOB_RETRY_AFTER_MIN_SECONDS_,
      remainingSeconds + JOB_RETRY_AFTER_SAFETY_BUFFER_SECONDS_
    )
  );
}

function createJobClaimResult_(claimed, status, leaseExpiresAt, retryAfterSeconds) {
  return {
    claimed: claimed,
    status: status,
    leaseExpiresAt: leaseExpiresAt || null,
    retryAfterSeconds: Number.isSafeInteger(retryAfterSeconds) ? retryAfterSeconds : null
  };
}

function claimJob_(job) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var existing = findJobByWebhookId_(job.webhookEventId);
    var nowMilliseconds = Date.now();
    if (existing) {
      var existingStatus = String(existing.Status || '');
      if (['COMPLETED', 'REJECTED', 'UNSENT'].indexOf(existingStatus) >= 0) {
        return createJobClaimResult_(false, existingStatus, existing.LeaseExpiresAt, null);
      }
      if (existingStatus === 'PROCESSING' && isJobLeaseActive_(existing, nowMilliseconds)) {
        return createJobClaimResult_(
          false,
          existingStatus,
          existing.LeaseExpiresAt,
          getJobRetryAfterSeconds_(existing.LeaseExpiresAt, nowMilliseconds)
        );
      }
      if (existingStatus !== 'FAILED' && existingStatus !== 'PROCESSING') {
        return createJobClaimResult_(false, existingStatus, existing.LeaseExpiresAt, null);
      }
    }
    var now = getTaipeiNow_();
    var leaseExpiresAt = getNewJobLeaseExpiration_();
    if (existing) {
      var retryCount = Number(existing.RetryCount) || 0;
      var sheet = getAdminSheet_('Jobs');
      sheet.getRange(existing._row, 3, 1, 8).setValues([[
        'PROCESSING', retryCount + 1, leaseExpiresAt, existing.DriveFileId || '', '', '', existing.CreatedAt, now
      ]]);
    } else {
      appendAdminRow_('Jobs', [
        job.webhookEventId,
        job.messageId || '',
        'PROCESSING',
        0,
        leaseExpiresAt,
        '',
        '',
        '',
        now,
        now
      ]);
    }
    return createJobClaimResult_(true, 'PROCESSING', leaseExpiresAt, null);
  } finally {
    lock.releaseLock();
  }
}

var JOB_DRIVE_FILE_UPDATE_ = Object.freeze({
  PRESERVE: 'PRESERVE',
  CLEAR: 'CLEAR',
  SET: 'SET'
});

function preserveJobDriveFileId_() {
  return { mode: JOB_DRIVE_FILE_UPDATE_.PRESERVE, value: '' };
}

function clearJobDriveFileId_() {
  return { mode: JOB_DRIVE_FILE_UPDATE_.CLEAR, value: '' };
}

function setJobDriveFileId_(driveFileId) {
  if (typeof driveFileId !== 'string' || driveFileId.length === 0 || driveFileId.length > 200) {
    throw createAppError_('DRIVE_FILE_ID_INVALID', false, 'Drive 檔案識別資料不正確。');
  }
  return { mode: JOB_DRIVE_FILE_UPDATE_.SET, value: driveFileId };
}

function resolveJobDriveFileId_(existingDriveFileId, driveFileUpdate) {
  if (!driveFileUpdate || driveFileUpdate.mode === JOB_DRIVE_FILE_UPDATE_.PRESERVE) {
    return String(existingDriveFileId || '').slice(0, 200);
  }
  if (driveFileUpdate.mode === JOB_DRIVE_FILE_UPDATE_.CLEAR) {
    return '';
  }
  if (driveFileUpdate.mode === JOB_DRIVE_FILE_UPDATE_.SET) {
    return String(driveFileUpdate.value || '').slice(0, 200);
  }
  throw createAppError_('JOB_DRIVE_FILE_UPDATE_INVALID', false, '工作檔案狀態更新無效。');
}

function updateJob_(webhookEventId, status, driveFileUpdate, errorCode, safeMessage, leaseExpiresAt) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var existing = findJobByWebhookId_(webhookEventId);
    if (!existing) {
      throw createAppError_('JOB_NOT_FOUND', true, '找不到工作紀錄。');
    }
    getAdminSheet_('Jobs').getRange(existing._row, 3, 1, 8).setValues([[
      status,
      Number(existing.RetryCount) || 0,
      leaseExpiresAt || '',
      resolveJobDriveFileId_(existing.DriveFileId, driveFileUpdate),
      String(errorCode || '').slice(0, 60),
      String(safeMessage || '').slice(0, 500),
      existing.CreatedAt,
      getTaipeiNow_()
    ]]);
  } finally {
    lock.releaseLock();
  }
}

function completeJob_(webhookEventId, driveFileId) {
  updateJob_(
    webhookEventId,
    'COMPLETED',
    driveFileId ? setJobDriveFileId_(driveFileId) : preserveJobDriveFileId_(),
    '',
    ''
  );
}

function recordJobDriveFile_(webhookEventId, driveFileId) {
  updateJob_(
    webhookEventId,
    'PROCESSING',
    setJobDriveFileId_(driveFileId),
    '',
    '',
    getNewJobLeaseExpiration_()
  );
}

function touchJobLease_(webhookEventId) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var existing = findJobByWebhookId_(webhookEventId);
    if (!existing) {
      throw createAppError_('JOB_NOT_FOUND', true, '找不到工作紀錄。');
    }
    if (existing.Status !== 'PROCESSING') {
      return false;
    }
    var sheet = getAdminSheet_('Jobs');
    sheet.getRange(existing._row, 5).setValue(getNewJobLeaseExpiration_());
    sheet.getRange(existing._row, 10).setValue(getTaipeiNow_());
    return true;
  } finally {
    lock.releaseLock();
  }
}

function rejectJob_(webhookEventId, errorCode, safeMessage) {
  updateJob_(webhookEventId, 'REJECTED', clearJobDriveFileId_(), errorCode, safeMessage);
}

function failJob_(webhookEventId, errorCode, safeMessage) {
  updateJob_(webhookEventId, 'FAILED', preserveJobDriveFileId_(), errorCode, safeMessage);
}

function markJobUnsent_(messageId) {
  var existing = findJobByMessageId_(messageId);
  if (!existing) {
    return null;
  }
  updateJob_(
    existing.WebhookEventId,
    'UNSENT',
    existing.DriveFileId
      ? setJobDriveFileId_(String(existing.DriveFileId))
      : preserveJobDriveFileId_(),
    '',
    '訊息已由傳送者收回。'
  );
  return existing;
}

function recordSafeError_(component, errorCode, safeMessage, correlationId) {
  appendAdminRow_('Errors', [
    getTaipeiNow_(),
    String(component || '').slice(0, 40),
    String(errorCode || '').slice(0, 60),
    String(safeMessage || '').slice(0, 500),
    String(correlationId || '').slice(0, 100)
  ]);
}
