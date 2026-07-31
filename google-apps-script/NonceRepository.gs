function getNonceHash_(nonce, purpose) {
  return hashIdentifier_('NONCE:' + purpose + ':' + nonce);
}

function assertNonceUnused_(nonce, purpose) {
  var nonceHash = getNonceHash_(nonce, purpose);
  var alreadyUsed = getSheetRecords_('Nonces').some(function (record) {
    return record.NonceHash === nonceHash;
  });
  if (alreadyUsed) {
    throw createAppError_('NONCE_REPLAYED', false, '此請求已處理，請勿重複送出。');
  }
  return nonceHash;
}

function consumeNonceWithoutLock_(nonce, purpose, expiresAt) {
  var nonceHash = assertNonceUnused_(nonce, purpose);
  appendAdminRow_('Nonces', [nonceHash, purpose, expiresAt, getTaipeiNow_()]);
}

function consumeNonce_(nonce, purpose, expiresAt) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    consumeNonceWithoutLock_(nonce, purpose, expiresAt);
  } finally {
    lock.releaseLock();
  }
}
