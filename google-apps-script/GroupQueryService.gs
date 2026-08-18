var GROUP_QUERY_SAFE_CODE_PATTERN_ = /^g_[a-f0-9]{8}$/i;
var GROUP_QUERY_DATE_ERROR_MESSAGE_ = '查詢格式不正確，請使用：備份清單、今日備份清單、本週備份清單、8月備份清單、2026年8月備份清單。';
var GROUP_QUERY_NOT_BOUND_MESSAGE_ = '本群組尚未綁定，請由已完成個人綁定的使用者輸入「綁定群組」。';
var GROUP_QUERY_EMPTY_MESSAGE_ = '查無此期間的群組備份紀錄。';

function getTaipeiDateParts_(milliseconds) {
  var value = Utilities.formatDate(new Date(milliseconds || Date.now()), 'Asia/Taipei', 'yyyy-MM-dd');
  var parts = value.split('-');
  return { year: Number(parts[0]), month: Number(parts[1]), day: Number(parts[2]) };
}

function buildTaipeiDateMilliseconds_(year, month, day) {
  return new Date(
    String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' +
    String(day).padStart(2, '0') + 'T00:00:00+08:00'
  ).getTime();
}

function buildGroupMonthRange_(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  var nextYear = month === 12 ? year + 1 : year;
  var nextMonth = month === 12 ? 1 : month + 1;
  return {
    startMilliseconds: buildTaipeiDateMilliseconds_(year, month, 1),
    endMilliseconds: buildTaipeiDateMilliseconds_(nextYear, nextMonth, 1),
    label: String(year) + '/' + String(month).padStart(2, '0'),
    startDate: String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-01',
    endDate: Utilities.formatDate(
      new Date(buildTaipeiDateMilliseconds_(nextYear, nextMonth, 1) - 86400000),
      'Asia/Taipei',
      'yyyy-MM-dd'
    )
  };
}

function parseGroupSummaryQuery_(rawText, nowMilliseconds) {
  var text = String(rawText || '').trim();
  var now = Number.isSafeInteger(nowMilliseconds) ? nowMilliseconds : Date.now();
  var today = getTaipeiDateParts_(now);
  if (text === '備份清單') {
    return buildGroupMonthRange_(today.year, today.month);
  }
  if (text === '今日備份清單') {
    var todayStart = buildTaipeiDateMilliseconds_(today.year, today.month, today.day);
    return {
      startMilliseconds: todayStart,
      endMilliseconds: todayStart + 86400000,
      label: String(today.year) + '/' + String(today.month).padStart(2, '0') + '/' + String(today.day).padStart(2, '0'),
      startDate: Utilities.formatDate(new Date(todayStart), 'Asia/Taipei', 'yyyy-MM-dd'),
      endDate: Utilities.formatDate(new Date(todayStart), 'Asia/Taipei', 'yyyy-MM-dd')
    };
  }
  if (text === '本週備份清單') {
    var noon = new Date(buildTaipeiDateMilliseconds_(today.year, today.month, today.day) + 12 * 60 * 60 * 1000);
    var weekday = noon.getUTCDay();
    var mondayOffset = (weekday + 6) % 7;
    var weekStart = buildTaipeiDateMilliseconds_(today.year, today.month, today.day) - mondayOffset * 86400000;
    var weekEnd = weekStart + 7 * 86400000;
    return {
      startMilliseconds: weekStart,
      endMilliseconds: weekEnd,
      label: Utilities.formatDate(new Date(weekStart), 'Asia/Taipei', 'yyyy/MM/dd') + '～' +
        Utilities.formatDate(new Date(weekEnd - 86400000), 'Asia/Taipei', 'MM/dd'),
      startDate: Utilities.formatDate(new Date(weekStart), 'Asia/Taipei', 'yyyy-MM-dd'),
      endDate: Utilities.formatDate(new Date(weekEnd - 86400000), 'Asia/Taipei', 'yyyy-MM-dd')
    };
  }
  var monthMatch = text.match(/^(\d{1,2})月備份清單$/u);
  if (monthMatch) {
    return buildGroupMonthRange_(today.year, Number(monthMatch[1]));
  }
  var yearMonthMatch = text.match(/^(\d{4})年(\d{1,2})月備份清單$/u);
  if (yearMonthMatch) {
    return buildGroupMonthRange_(Number(yearMonthMatch[1]), Number(yearMonthMatch[2]));
  }
  var isoMonthMatch = text.match(/^(\d{4})-(\d{2}) 備份清單$/u);
  if (isoMonthMatch) {
    return buildGroupMonthRange_(Number(isoMonthMatch[1]), Number(isoMonthMatch[2]));
  }
  return null;
}

function readBackupRecordsForGroupQuery_(accessToken, spreadsheetId) {
  var response = googleApiFetch_(
    'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) +
      '/values/' + encodeURIComponent('備份紀錄!A:AZ'),
    { method: 'get' },
    accessToken,
    'GROUP_QUERY_READ_FAILED'
  );
  var result = parseJsonResponse_(response, 'GROUP_QUERY_RESPONSE_INVALID');
  var values = Array.isArray(result.values) ? result.values : [];
  var headers = Array.isArray(values[0]) ? values[0].map(function (value) {
    return String(value || '').trim();
  }) : [];
  return {
    headers: headers,
    records: values.slice(1).map(function (row) {
      var record = {};
      if (Array.isArray(row)) {
        headers.forEach(function (header, index) {
          if (header) {
            record[header] = row[index] || '';
          }
        });
      }
      return record;
    })
  };
}

function getGroupQueryField_(record, name) {
  return record && Object.prototype.hasOwnProperty.call(record, name) ? record[name] : '';
}

function isSuccessfulGroupRecord_(record) {
  return ['完成', '已備份', '成功', 'COMPLETED', 'SUCCESS'].indexOf(
    String(getGroupQueryField_(record, '狀態') || '').trim()
  ) >= 0;
}

function getGroupSummaryRecordType_(record) {
  var messageType = String(getGroupQueryField_(record, '訊息類型') || '').toLowerCase();
  if (messageType === 'text' && /^#筆記(?:\s|$)/u.test(String(getGroupQueryField_(record, '文字內容') || '').trim())) {
    return 'note';
  }
  return messageType || 'text';
}

function sanitizeGroupSummaryText_(value, maximumLength) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\b[UC][a-f0-9]{32}\b/gi, '[已隱藏識別]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[已隱藏雜湊]')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, maximumLength || 80);
}

function canUseLegacyGroupNameFallback_(group) {
  var groupName = String(group && group.GroupName || '');
  if (!groupName) {
    return false;
  }
  var sameNameGroups = getSheetRecords_('Groups').filter(function (record) {
    return record.OwnerLineUserHash === group.OwnerLineUserHash &&
      String(record.GroupName || '') === groupName;
  });
  return sameNameGroups.length === 1;
}

function isGroupRecordSource_(record) {
  var sourceType = String(getGroupQueryField_(record, '來源類型') || '').toLowerCase();
  return sourceType === '群組' || sourceType === 'group';
}

function isLegacyGroupRecordForGroup_(record, group) {
  var groupName = String(group && group.GroupName || '');
  return isGroupRecordSource_(record) &&
    !String(getGroupQueryField_(record, '群組識別') || '').trim() &&
    Boolean(groupName) &&
    String(getGroupQueryField_(record, '群組名稱') || '') === groupName;
}

function buildGroupSummary_(group, owner, query) {
  var accessToken = getUserAccessToken_(group.OwnerLineUserHash);
  var sheetData = readBackupRecordsForGroupQuery_(accessToken, owner.SheetId);
  var legacyFallback = canUseLegacyGroupNameFallback_(group);
  var hasLegacyGroupRecords = sheetData.records.some(function (record) {
    return isGroupRecordSource_(record) &&
      !String(getGroupQueryField_(record, '群組識別') || '').trim();
  });
  if (hasLegacyGroupRecords && !legacyFallback) {
    throw createAppError_('GROUP_IDENTIFIER_MISSING', false, '舊紀錄缺少群組識別，且群組名稱無法唯一確認，請僅查詢新版本後的群組紀錄。');
  }
  var legacyUsed = false;
  var records = sheetData.records.filter(function (record) {
    if (!isGroupRecordSource_(record)) {
      return false;
    }
    if (!isSuccessfulGroupRecord_(record)) {
      return false;
    }
    var identifierMatches = String(getGroupQueryField_(record, '群組識別') || '') === group.GroupIdHash;
    var legacyMatches = legacyFallback && isLegacyGroupRecordForGroup_(record, group);
    if (!identifierMatches && !legacyMatches) {
      return false;
    }
    if (!identifierMatches && legacyMatches) {
      legacyUsed = true;
    }
    var timestamp = parseStoredDateMilliseconds_(getGroupQueryField_(record, 'LINE 訊息時間'));
    return Number.isFinite(timestamp) && timestamp >= query.startMilliseconds && timestamp < query.endMilliseconds;
  });
  records.sort(function (left, right) {
    return parseStoredDateMilliseconds_(getGroupQueryField_(right, 'LINE 訊息時間')) -
      parseStoredDateMilliseconds_(getGroupQueryField_(left, 'LINE 訊息時間'));
  });
  var counts = { image: 0, video: 0, audio: 0, file: 0, note: 0, text: 0 };
  records.forEach(function (record) {
    var type = getGroupSummaryRecordType_(record);
    if (Object.prototype.hasOwnProperty.call(counts, type)) {
      counts[type] += 1;
    } else {
      counts.file += 1;
    }
  });
  return { records: records, counts: counts, legacyFallback: legacyUsed };
}

function formatGroupSummaryReply_(group, query, summary) {
  if (summary.records.length === 0) {
    return GROUP_QUERY_EMPTY_MESSAGE_;
  }
  var lines = [
    '📦 ' + query.label + ' 群組備份摘要',
    '群組：' + sanitizeGroupSummaryText_(group.GroupName, 80),
    '總筆數：' + summary.records.length + ' 筆',
    '圖片：' + summary.counts.image + ' 筆',
    '影片：' + summary.counts.video + ' 筆',
    '音訊：' + summary.counts.audio + ' 筆',
    '檔案：' + summary.counts.file + ' 筆',
    '筆記：' + summary.counts.note + ' 筆',
    '文字：' + summary.counts.text + ' 筆',
    '',
    '最新 ' + Math.min(5, summary.records.length) + ' 筆：'
  ];
  summary.records.slice(0, 5).forEach(function (record, index) {
    var typeNames = { image: '圖片', video: '影片', audio: '音訊', file: '檔案', note: '筆記', text: '文字' };
    var type = getGroupSummaryRecordType_(record);
    var dateText = sanitizeGroupSummaryText_(String(getGroupQueryField_(record, 'LINE 訊息時間') || '').slice(5, 10).replace('-', '/'), 10);
    var name = getGroupQueryField_(record, '原始檔名') || getGroupQueryField_(record, '文字內容') || typeNames[type] || '紀錄';
    if (type === 'note') {
      name = String(name).replace(/^#筆記\s*/u, '');
    }
    lines.push((index + 1) + '. ' + dateText + ' ' + (typeNames[type] || '檔案') + '：' + sanitizeGroupSummaryText_(name, 60));
  });
  lines.push('', '群組內只顯示摘要，不顯示 Drive 檔案連結。');
  if (summary.legacyFallback) {
    lines.push('提醒：舊紀錄缺少群組識別，已使用唯一群組名稱比對。新紀錄會使用安全群組識別。');
  }
  lines.push('完整清單僅限群組備份擁有者私訊輸入「群組紀錄」查詢。');
  return lines.join('\n');
}

function getGroupBackupSummaryReply_(job) {
  if (!job.groupIdHash) {
    return '群組備份清單請在 LINE 群組內查詢。';
  }
  var query = parseGroupSummaryQuery_(job.rawText, Date.now());
  if (!query) {
    return GROUP_QUERY_DATE_ERROR_MESSAGE_;
  }
  var group = findEnabledGroupByHash_(job.groupIdHash);
  if (!group) {
    return GROUP_QUERY_NOT_BOUND_MESSAGE_;
  }
  var owner = findEnabledUserByHash_(group.OwnerLineUserHash);
  if (!owner || !owner.SheetId) {
    return GROUP_QUERY_NOT_BOUND_MESSAGE_;
  }
  try {
    return formatGroupSummaryReply_(group, query, buildGroupSummary_(group, owner, query));
  } catch (error) {
    var appError = isAppError_(error) ? error : createAppError_('GROUP_QUERY_FAILED', true, '暫時無法查詢群組備份清單，請稍後再試。');
    safeLog_('warn', 'group-query', appError.appCode, job.webhookEventId || 'group-query');
    throw createAppError_('GROUP_QUERY_FAILED', true, '暫時無法查詢群組備份清單，請稍後再試。');
  }
}

function getGroupQuerySafeCode_(groupIdHash) {
  return 'g_' + String(groupIdHash || '').slice(0, 8).toLowerCase();
}

function getGroupsAvailableForQuery_(lineUserHash) {
  var groups = getSheetRecords_('Groups').filter(function (group) { return group.Enabled === true; });
  if (isAdminLineUserHash_(lineUserHash)) {
    return groups;
  }
  return groups.filter(function (group) { return group.OwnerLineUserHash === lineUserHash; });
}

function formatGroupQueryList_(groups, period) {
  var lines = ['可查詢的群組：'];
  groups.forEach(function (group) {
    lines.push(getGroupQuerySafeCode_(group.GroupIdHash) + '：' + sanitizeGroupSummaryText_(group.GroupName, 80));
  });
  if (period) {
    lines.push('', '請輸入：群組紀錄 ' + period + ' ' + getGroupQuerySafeCode_(groups[0].GroupIdHash));
  } else {
    lines.push('', '請輸入「群組紀錄 YYYY-MM」查詢指定月份完整紀錄。');
  }
  return lines.join('\n');
}

function getGroupRecordQueryReply_(lineUserHash, job) {
  var groups = getGroupsAvailableForQuery_(lineUserHash);
  if (groups.length === 0) {
    return '你目前沒有可查詢完整紀錄的群組。完整群組紀錄僅限群組備份擁有者查詢。';
  }
  var rawArgument = String(job.rawText || '').replace(/^群組紀錄\s*/u, '').trim();
  if (!rawArgument) {
    return formatGroupQueryList_(groups, 'YYYY-MM');
  }
  var parts = rawArgument.split(/\s+/u).filter(function (part) { return part; });
  var period = '';
  var safeCode = '';
  parts.forEach(function (part) {
    if (/^\d{4}-\d{2}$/u.test(part)) {
      period = part;
    } else if (GROUP_QUERY_SAFE_CODE_PATTERN_.test(part)) {
      safeCode = part.toLowerCase();
    }
  });
  if (parts.some(function (part) { return !/^\d{4}-\d{2}$/u.test(part) && !GROUP_QUERY_SAFE_CODE_PATTERN_.test(part); })) {
    return '查詢格式不正確，請使用：群組紀錄、群組紀錄 YYYY-MM、群組紀錄 YYYY-MM g_xxxxxxxx。';
  }
  if (safeCode) {
    groups = groups.filter(function (group) { return getGroupQuerySafeCode_(group.GroupIdHash) === safeCode; });
    if (groups.length === 0) {
      return '找不到可查詢的群組。';
    }
  } else if (groups.length > 1) {
    return formatGroupQueryList_(groups, period || 'YYYY-MM');
  }
  var group = groups[0];
  var startDate = '';
  var endDate = '';
  if (period) {
    var match = period.match(/^(\d{4})-(\d{2})$/u);
    var range = buildGroupMonthRange_(Number(match[1]), Number(match[2]));
    if (!range) {
      return '查詢月份不正確，請使用 YYYY-MM。';
    }
    startDate = range.startDate;
    endDate = range.endDate;
  }
  return createGroupRecordQueryLink_(lineUserHash, group.GroupIdHash, startDate, endDate);
}

function getUniqueLegacyGroupMap_(groups) {
  var result = {};
  (Array.isArray(groups) ? groups : []).forEach(function (group) {
    var name = String(group.GroupName || '');
    if (!name) {
      return;
    }
    var key = String(group.OwnerLineUserHash || '') + '\n' + name;
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      result[key] = null;
    } else {
      result[key] = group;
    }
  });
  return result;
}

function readBackupSheetRowsForMigration_(accessToken, spreadsheetId) {
  var response = googleApiFetch_(
    'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId) +
      '/values/' + encodeURIComponent('備份紀錄!A:AZ'),
    { method: 'get' },
    accessToken,
    'GROUP_MIGRATION_READ_FAILED'
  );
  var result = parseJsonResponse_(response, 'GROUP_MIGRATION_RESPONSE_INVALID');
  var values = Array.isArray(result.values) ? result.values : [];
  return {
    headers: Array.isArray(values[0]) ? values[0].map(function (value) { return String(value || '').trim(); }) : [],
    rows: values.slice(1)
  };
}

/** 管理者手動執行；只為安全唯一的舊群組紀錄補上群組識別，不刪除或重建資料。 */
function migrateLegacyGroupRecordHashes() {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var scanCount = 0;
  var completedCount = 0;
  var skippedCount = 0;
  var ambiguousCount = 0;
  try {
    var groups = getSheetRecords_('Groups');
    var groupsByOwner = {};
    groups.forEach(function (group) {
      if (!group.OwnerLineUserHash || !group.SheetId) {
        return;
      }
      if (!groupsByOwner[group.OwnerLineUserHash]) {
        groupsByOwner[group.OwnerLineUserHash] = [];
      }
      groupsByOwner[group.OwnerLineUserHash].push(group);
    });
    Object.keys(groupsByOwner).forEach(function (ownerLineUserHash) {
      var owner = findEnabledUserByHash_(ownerLineUserHash);
      var ownerGroups = groupsByOwner[ownerLineUserHash];
      if (!owner || !owner.SheetId) {
        skippedCount += ownerGroups.length;
        return;
      }
      var accessToken;
      try {
        accessToken = getUserAccessToken_(ownerLineUserHash);
        var sheetData = readBackupSheetRowsForMigration_(accessToken, owner.SheetId);
        var headers = sheetData.headers;
        if (headers.indexOf('群組識別') < 0) {
          headers = ensureBackupSheetHeaders_(accessToken, owner.SheetId);
          sheetData = readBackupSheetRowsForMigration_(accessToken, owner.SheetId);
          headers = sheetData.headers;
        }
        var groupIdentifierColumn = headers.indexOf('群組識別');
        var groupNameColumn = headers.indexOf('群組名稱');
        var sourceTypeColumn = headers.indexOf('來源類型');
        if (groupIdentifierColumn < 0 || groupNameColumn < 0 || sourceTypeColumn < 0) {
          skippedCount += ownerGroups.length;
          return;
        }
        var uniqueGroups = getUniqueLegacyGroupMap_(ownerGroups);
        sheetData.rows.forEach(function (row, rowIndex) {
          var sourceType = String(row[sourceTypeColumn] || '').toLowerCase();
          var currentHash = String(row[groupIdentifierColumn] || '').trim();
          if ((sourceType !== '群組' && sourceType !== 'group') || currentHash) {
            return;
          }
          scanCount += 1;
          var groupName = String(row[groupNameColumn] || '');
          var key = ownerLineUserHash + '\n' + groupName;
          var group = Object.prototype.hasOwnProperty.call(uniqueGroups, key)
            ? uniqueGroups[key]
            : null;
          if (!group) {
            if (Object.prototype.hasOwnProperty.call(uniqueGroups, key)) {
              ambiguousCount += 1;
            } else {
              skippedCount += 1;
            }
            return;
          }
          var rowNumber = rowIndex + 2;
          updateSheetValues_(
            accessToken,
            owner.SheetId,
            '備份紀錄!' + getSheetColumnLetter_(groupIdentifierColumn + 1) + rowNumber,
            [[group.GroupIdHash]]
          );
          completedCount += 1;
        });
      } catch (error) {
        skippedCount += ownerGroups.length;
        safeLog_('warn', 'group-migration', isAppError_(error) ? error.appCode : 'GROUP_MIGRATION_FAILED', 'group-migration');
      }
    });
    Logger.log('migrateLegacyGroupRecordHashes 掃描筆數：' + scanCount);
    Logger.log('migrateLegacyGroupRecordHashes 成功補齊筆數：' + completedCount);
    Logger.log('migrateLegacyGroupRecordHashes 略過筆數：' + skippedCount);
    Logger.log('migrateLegacyGroupRecordHashes 同名或不確定筆數：' + ambiguousCount);
    return {
      scanned: scanCount,
      completed: completedCount,
      skipped: skippedCount,
      ambiguous: ambiguousCount
    };
  } finally {
    lock.releaseLock();
  }
}
