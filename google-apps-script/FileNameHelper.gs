function sanitizeFileName_(rawName, fallbackName) {
  var fallback = String(fallbackName || '未命名檔案').slice(0, 100);
  var value = typeof rawName === 'string' ? rawName : '';
  value = value
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .trim();
  if (!value) {
    value = fallback;
  }
  return value.slice(0, 180);
}

function extensionForContentType_(contentType) {
  var normalized = String(contentType || '').split(';')[0].toLowerCase();
  var extensions = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'audio/m4a': '.m4a',
    'audio/mp4': '.m4a',
    'audio/mpeg': '.mp3',
    'application/pdf': '.pdf'
  };
  return extensions[normalized] || '';
}

function createBackupFileName_(job, contentType) {
  if (job.messageType === 'file') {
    return sanitizeFileName_(job.fileName, 'file_' + job.messageId);
  }
  var prefixByType = { image: 'image', video: 'video', audio: 'audio' };
  var prefix = prefixByType[job.messageType] || 'content';
  var timestamp = Utilities.formatDate(new Date(job.timestamp), 'Asia/Taipei', 'yyyyMMdd_HHmmss_SSS');
  var safeMessageId = sanitizeFileName_(job.messageId, 'unknown').slice(-40);
  return prefix + '_' + timestamp + '_' + safeMessageId + extensionForContentType_(contentType);
}

function extractTags_(text) {
  var result = [];
  var seen = {};
  var matcher = /#([\p{L}\p{N}_-]{1,50})/gu;
  var match;
  while ((match = matcher.exec(String(text || ''))) !== null && result.length < 20) {
    var tag = match[1];
    if (tag !== '筆記' && !seen[tag]) {
      seen[tag] = true;
      result.push(tag);
    }
  }
  return result;
}

function extractUrls_(text) {
  var matches = String(text || '').match(/https?:\/\/[^\s<>"'，。；、！？]{1,2048}/gi) || [];
  var result = [];
  var seen = {};
  matches.forEach(function (candidate) {
    var normalized = candidate.replace(/[。；，、！？.!?,;:]+$/g, '');
    if (!seen[normalized] && result.length < 20) {
      seen[normalized] = true;
      result.push(normalized);
    }
  });
  return result;
}
