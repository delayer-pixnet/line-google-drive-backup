function findGroupByHash_(groupIdHash) {
  return getSheetRecords_('Groups').find(function (record) {
    return record.GroupIdHash === groupIdHash;
  }) || null;
}

function findEnabledGroupByHash_(groupIdHash) {
  var group = findGroupByHash_(groupIdHash);
  return group && group.Enabled === true ? group : null;
}

function upsertGroup_(groupData) {
  var sheet = getAdminSheet_('Groups');
  var existing = findGroupByHash_(groupData.groupIdHash);
  var now = getTaipeiNow_();
  var values = [
    groupData.groupIdHash,
    groupData.ownerLineUserHash,
    String(groupData.groupName || '').slice(0, 200),
    groupData.folderId,
    groupData.sheetId,
    true,
    existing ? existing.CreatedAt : now,
    now
  ];
  if (existing) {
    sheet.getRange(existing._row, 1, 1, values.length).setValues([values]);
  } else {
    sheet.appendRow(values);
  }
}

function disableGroup_(groupIdHash, ownerLineUserHash) {
  var existing = findGroupByHash_(groupIdHash);
  if (!existing || (ownerLineUserHash && existing.OwnerLineUserHash !== ownerLineUserHash)) {
    return false;
  }
  var sheet = getAdminSheet_('Groups');
  sheet.getRange(existing._row, 6).setValue(false);
  sheet.getRange(existing._row, 8).setValue(getTaipeiNow_());
  return true;
}

function disableGroupsOwnedBy_(ownerLineUserHash) {
  var sheet = getAdminSheet_('Groups');
  getSheetRecords_('Groups').forEach(function (record) {
    if (record.OwnerLineUserHash === ownerLineUserHash && record.Enabled === true) {
      sheet.getRange(record._row, 6).setValue(false);
      sheet.getRange(record._row, 8).setValue(getTaipeiNow_());
    }
  });
}
