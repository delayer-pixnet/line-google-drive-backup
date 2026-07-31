function createAppError_(code, retryable, safeMessage) {
  var error = new Error(safeMessage);
  error.appCode = code;
  error.retryable = retryable === true;
  error.safeMessage = safeMessage;
  return error;
}

function isAppError_(error) {
  return error && typeof error === 'object' && typeof error.appCode === 'string';
}

function bytesToHex_(bytes) {
  return bytes.map(function (value) {
    var unsigned = value < 0 ? value + 256 : value;
    return unsigned.toString(16).padStart(2, '0');
  }).join('');
}

function hmacHex_(secret, message) {
  return bytesToHex_(Utilities.computeHmacSha256Signature(message, secret));
}

function constantTimeEqual_(left, right) {
  var leftText = String(left || '');
  var rightText = String(right || '');
  var maximumLength = Math.max(leftText.length, rightText.length);
  var difference = leftText.length ^ rightText.length;
  for (var index = 0; index < maximumLength; index += 1) {
    difference |= (leftText.charCodeAt(index) || 0) ^ (rightText.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function hashIdentifier_(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.length === 0 || rawValue.length > 200) {
    throw createAppError_('IDENTIFIER_INVALID', false, '識別資料格式不正確。');
  }
  return hmacHex_(getRequiredProperty_(APP_CONFIG_KEYS_.IDENTIFIER_HASH_SECRET), rawValue);
}

function hashWithSecret_(rawValue, secret) {
  return hmacHex_(secret, String(rawValue));
}

function verifyWorkerEnvelope_(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw createAppError_('ENVELOPE_INVALID', false, '請求格式不正確。');
  }
  var timestamp = envelope.timestamp;
  var nonce = envelope.nonce;
  var payload = envelope.payload;
  var signature = envelope.signature;
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
    throw createAppError_('TIMESTAMP_INVALID', false, '請求已過期。');
  }
  if (typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)) {
    throw createAppError_('NONCE_INVALID', false, '請求驗證失敗。');
  }
  if (typeof payload !== 'string' || payload.length === 0 || payload.length > 100000) {
    throw createAppError_('PAYLOAD_INVALID', false, '請求內容不正確。');
  }
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) {
    throw createAppError_('SIGNATURE_INVALID', false, '請求驗證失敗。');
  }
  var expected = hmacHex_(
    getRequiredProperty_(APP_CONFIG_KEYS_.WORKER_GAS_SHARED_SECRET),
    timestamp + '.' + nonce + '.' + payload
  );
  if (!constantTimeEqual_(expected, signature)) {
    throw createAppError_('SIGNATURE_INVALID', false, '請求驗證失敗。');
  }
  consumeNonce_(nonce, 'WORKER_REQUEST', new Date(timestamp + 5 * 60 * 1000));
  return payload;
}

function decodeWebSafeJson_(encoded) {
  try {
    var bytes = Utilities.base64DecodeWebSafe(encoded);
    return JSON.parse(Utilities.newBlob(bytes).getDataAsString('UTF-8'));
  } catch (error) {
    throw createAppError_('BIND_TOKEN_INVALID', false, '綁定連結無效。');
  }
}

function verifyBindToken_(token) {
  if (typeof token !== 'string' || token.length > 2000) {
    throw createAppError_('BIND_TOKEN_INVALID', false, '綁定連結無效。');
  }
  var parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1])) {
    throw createAppError_('BIND_TOKEN_INVALID', false, '綁定連結無效。');
  }
  var expected = hmacHex_(getRequiredProperty_(APP_CONFIG_KEYS_.BIND_TOKEN_SECRET), parts[0]);
  if (!constantTimeEqual_(expected, parts[1])) {
    throw createAppError_('BIND_TOKEN_INVALID', false, '綁定連結無效。');
  }
  var payload = decodeWebSafeJson_(parts[0]);
  if (
    payload.version !== 2 ||
    typeof payload.lineUserHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(payload.lineUserHash) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt < Date.now() ||
    typeof payload.nonce !== 'string' ||
    !/^[a-f0-9]{16,64}$/.test(payload.nonce)
  ) {
    throw createAppError_('BIND_TOKEN_EXPIRED', false, '綁定連結已失效，請回 LINE 重新取得。');
  }
  return payload;
}

function validateQueueJob_(job) {
  var eventTypes = ['message', 'join', 'leave', 'follow', 'unfollow', 'unsend'];
  var messageTypes = ['text', 'image', 'video', 'audio', 'file'];
  if (!job || typeof job !== 'object' || job.schemaVersion !== 1) {
    throw createAppError_('JOB_INVALID', false, '工作格式不正確。');
  }
  if (eventTypes.indexOf(job.eventType) < 0) {
    throw createAppError_('JOB_EVENT_INVALID', false, '事件類型不正確。');
  }
  if (typeof job.webhookEventId !== 'string' || job.webhookEventId.length > 128) {
    throw createAppError_('JOB_ID_INVALID', false, '事件識別資料不正確。');
  }
  if (!Number.isSafeInteger(job.timestamp) || job.timestamp < 0) {
    throw createAppError_('JOB_TIMESTAMP_INVALID', false, '事件時間不正確。');
  }
  if (job.messageType !== null && messageTypes.indexOf(job.messageType) < 0) {
    throw createAppError_('JOB_MESSAGE_INVALID', false, '訊息類型不正確。');
  }
  ['messageId', 'lineUserId', 'groupId', 'replyToken', 'fileName', 'rawText', 'bindToken'].forEach(function (name) {
    var value = job[name];
    if (value !== null && (typeof value !== 'string' || value.length > 5000)) {
      throw createAppError_('JOB_FIELD_INVALID', false, '事件欄位不正確。');
    }
  });
  return job;
}

function safeLog_(level, component, errorCode, correlationId) {
  var entry = JSON.stringify({
    component: String(component || '').slice(0, 40),
    errorCode: String(errorCode || '').slice(0, 60),
    correlationId: String(correlationId || '').slice(0, 100)
  });
  if (level === 'error') {
    console.error(entry);
  } else if (level === 'warn') {
    console.warn(entry);
  } else {
    console.info(entry);
  }
}
