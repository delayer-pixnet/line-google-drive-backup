function normalizeInviteCode_(inviteCode) {
  if (typeof inviteCode !== 'string') {
    return null;
  }
  var normalized = inviteCode.trim().toUpperCase();
  return /^[A-Z0-9-]{4,64}$/.test(normalized) ? normalized : null;
}

function findInvitationByHash_(inviteCodeHash) {
  return getSheetRecords_('Invitations').find(function (item) {
    return item.InviteCodeHash === inviteCodeHash;
  }) || null;
}

function isInvitationAvailable_(record, nowMilliseconds) {
  if (!record || record.Enabled !== true) {
    return false;
  }
  var maximumUses = Number(record.MaxUses);
  var usedCount = Number(record.UsedCount);
  var expiresAt = parseStoredDateMilliseconds_(record.ExpiresAt);
  return Number.isFinite(maximumUses) &&
    Number.isFinite(usedCount) &&
    maximumUses > usedCount &&
    !Number.isNaN(expiresAt) &&
    expiresAt >= nowMilliseconds;
}

function findAvailableInvitationForBinding_(inviteCode) {
  var normalized = normalizeInviteCode_(inviteCode);
  if (!normalized) {
    return null;
  }
  var inviteCodeHash = hashIdentifier_('INVITE:' + normalized);
  var record = findInvitationByHash_(inviteCodeHash);
  return isInvitationAvailable_(record, Date.now())
    ? { inviteCodeHash: inviteCodeHash, record: record }
    : null;
}

/** 管理者在 Apps Script 編輯器手動執行；邀請碼只會以雜湊寫入試算表。 */
function createInvitationForAdmin_(inviteCode, maximumUses, expiresAt) {
  var normalized = normalizeInviteCode_(inviteCode);
  if (!normalized || !Number.isSafeInteger(maximumUses) || maximumUses <= 0) {
    throw new Error('邀請碼或使用次數格式不正確。');
  }
  var expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) {
    throw new Error('邀請碼期限必須是未來時間。');
  }
  appendAdminRow_('Invitations', [
    hashIdentifier_('INVITE:' + normalized),
    true,
    maximumUses,
    0,
    expiry,
    getTaipeiNow_()
  ]);
}
