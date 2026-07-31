function deleteAdminRowsWhere_(sheetName, predicate) {
  var sheet = getAdminSheet_(sheetName);
  var rowsToDelete = getSheetRecords_(sheetName)
    .filter(predicate)
    .map(function (record) { return record._row; })
    .sort(function (left, right) { return right - left; });
  rowsToDelete.forEach(function (rowNumber) {
    sheet.deleteRow(rowNumber);
  });
  return rowsToDelete.length;
}

/** 管理者定期手動執行；只清除可再生的管理紀錄，不碰使用者設定或 Drive 檔案。 */
function cleanupExpiredAdminRecords() {
  var now = Date.now();
  var errorRetentionDays = getRetentionDays_(APP_CONFIG_KEYS_.ERROR_RETENTION_DAYS, 30);
  var completedJobRetentionDays = getRetentionDays_(
    APP_CONFIG_KEYS_.COMPLETED_JOB_RETENTION_DAYS,
    90
  );
  var errorCutoff = now - errorRetentionDays * 24 * 60 * 60 * 1000;
  var completedJobCutoff = now - completedJobRetentionDays * 24 * 60 * 60 * 1000;
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var counts = {
      nonces: deleteAdminRowsWhere_('Nonces', function (record) {
        var expiresAt = parseStoredDateMilliseconds_(record.ExpiresAt);
        return Number.isFinite(expiresAt) && expiresAt < now;
      }),
      bindingSessions: deleteAdminRowsWhere_('BindingSessions', function (record) {
        var expiresAt = parseStoredDateMilliseconds_(record.ExpiresAt);
        // AUTHORIZED／PROVISIONING／FAILED 仍可恢復，不可因原 Bind Token 到期而刪除。
        return ['PENDING', 'COMPLETED'].indexOf(String(record.Status)) >= 0 &&
          Number.isFinite(expiresAt) &&
          expiresAt < now;
      }),
      errors: deleteAdminRowsWhere_('Errors', function (record) {
        var timestamp = parseStoredDateMilliseconds_(record.Timestamp);
        return Number.isFinite(timestamp) && timestamp < errorCutoff;
      }),
      completedJobs: deleteAdminRowsWhere_('Jobs', function (record) {
        var updatedAt = parseStoredDateMilliseconds_(record.UpdatedAt);
        return record.Status === 'COMPLETED' &&
          Number.isFinite(updatedAt) &&
          updatedAt < completedJobCutoff;
      })
    };
    console.log(JSON.stringify({ component: 'admin-cleanup', deletedCounts: counts }));
    return counts;
  } finally {
    lock.releaseLock();
  }
}
