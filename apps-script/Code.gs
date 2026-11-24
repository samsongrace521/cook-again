/**
 * Cook Again 料理紀錄 — Google Apps Script 後端
 *
 * 功能：
 *  - 把每一次的料理紀錄寫進 Google 試算表（一列 = 一次料理）
 *  - 把料理過程／成品照片存進 Google 雲端硬碟資料夾
 *  - 提供網頁 App 讀取、修改、刪除紀錄
 *
 * 安裝方式請看 docs/SETUP.md
 */

// ★★★ 請改成你自己取的一組密碼（英文＋數字，越長越好），網頁 App「設定」頁也要填一樣的 ★★★
const API_TOKEN = 'change-me-to-your-own-secret';

const SHEET_NAME = '料理紀錄';
const ROOT_FOLDER_NAME = 'Cook Again 料理照片';

const HEADERS = [
  '紀錄ID', '建立時間', '最後修改', '料理日期', '料理名稱', '類別', '第幾次做',
  '份量', '花費時間(分)', '評分', '成品照片預覽', '食材', '步驟', '成品心得',
  '改進建議', '下次調整', '標籤', '參考來源', '文字食譜', '照片資料夾', '原始資料JSON'
];
const COL = {};
HEADERS.forEach(function (h, i) { COL[h] = i + 1; });

/* ---------------- 進入點 ---------------- */

function doGet(e) {
  try {
    const p = e.parameter || {};
    checkToken_(p.token);
    const action = p.action || 'list';
    if (action === 'ping') return json_({ ok: true, message: '連線成功！' });
    if (action === 'list') return json_({ ok: true, records: listRecords_() });
    throw new Error('未知的 action：' + action);
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    checkToken_(body.token);
    if (body.action === 'save') return json_({ ok: true, record: saveRecord_(body.record) });
    if (body.action === 'delete') { deleteRecord_(body.id); return json_({ ok: true }); }
    throw new Error('未知的 action：' + body.action);
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

/** 第一次安裝時在編輯器手動執行一次：建立工作表、照片資料夾並要求授權 */
function setup() {
  const sheet = getSheet_();
  const folder = getRootFolder_();
  Logger.log('✅ 工作表：' + sheet.getParent().getUrl());
  Logger.log('✅ 照片資料夾：' + folder.getUrl());
  if (API_TOKEN === 'change-me-to-your-own-secret') {
    Logger.log('⚠️ 請記得把程式最上面的 API_TOKEN 改成你自己的密碼！');
  }
}

/* ---------------- 核心邏輯 ---------------- */

function checkToken_(token) {
  if (!token || token !== API_TOKEN) throw new Error('密碼(API_TOKEN)不正確，請檢查網頁 App 的設定');
}

function saveRecord_(rec) {
  if (!rec || !rec.dishName) throw new Error('缺少料理名稱');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getSheet_();
    const now = new Date();
    const isNew = !rec.id;
    if (isNew) {
      rec.id = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') + '-' +
        Utilities.getUuid().slice(0, 4);
      rec.createdAt = now.toISOString();
    }
    rec.updatedAt = now.toISOString();

    // 照片：把新上傳的 dataUrl 存到雲端硬碟，換成 fileId
    const folder = getRecordFolder_(rec);
    rec.folderUrl = folder.getUrl();
    rec.finalPhotos = uploadPhotos_(rec.finalPhotos, folder, '成品');
    (rec.steps || []).forEach(function (s, i) {
      s.photos = uploadPhotos_(s.photos, folder, '步驟' + (i + 1));
    });

    // 第幾次做這道菜（依料理名稱、日期排序計算）
    const rowIndex = findRow_(sheet, rec.id);
    if (isNew || !rec.attempt) rec.attempt = countAttempts_(sheet, rec.dishName, rec.id) + 1;
    if (rec.recipeText) rec.recipeText = String(rec.recipeText).replace(/第 \d+ 次/, '第 ' + rec.attempt + ' 次');

    const row = toRow_(rec);
    if (rowIndex > 0) {
      sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
    return rec;
  } finally {
    lock.releaseLock();
  }
}

function deleteRecord_(id) {
  const sheet = getSheet_();
  const r = findRow_(sheet, id);
  if (r < 0) throw new Error('找不到紀錄 ' + id);
  sheet.deleteRow(r); // 照片保留在雲端硬碟，避免誤刪
}

function listRecords_() {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, COL['原始資料JSON'], last - 1, 1).getValues();
  const out = [];
  values.forEach(function (v) {
    if (!v[0]) return;
    try { out.push(JSON.parse(v[0])); } catch (e) { /* 略過損壞資料 */ }
  });
  out.sort(function (a, b) { return String(b.date + b.createdAt).localeCompare(String(a.date + a.createdAt)); });
  return out;
}

/* ---------------- 照片 ---------------- */

function uploadPhotos_(photos, folder, prefix) {
  return (photos || []).map(function (p, i) {
    if (p.fileId) return { fileId: p.fileId, caption: p.caption || '' };
    if (!p.dataUrl) return null;
    const m = p.dataUrl.match(/^data:(.+?);base64,(.*)$/);
    if (!m) return null;
    const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1],
      prefix + '_' + (i + 1) + '_' + Date.now() + '.jpg');
    const file = folder.createFile(blob);
    try {
      // 設成「知道連結者可檢視」，網頁 App 才能顯示縮圖
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e) { /* 某些公司/學校帳號禁止公開分享，照片仍會保存 */ }
    return { fileId: file.getId(), caption: p.caption || '' };
  }).filter(Boolean);
}

function getRootFolder_() {
  const it = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(ROOT_FOLDER_NAME);
}

function getRecordFolder_(rec) {
  const root = getRootFolder_();
  if (rec.folderId) {
    try { return DriveApp.getFolderById(rec.folderId); } catch (e) { /* 重新建立 */ }
  }
  const f = root.createFolder((rec.date || '') + '_' + rec.dishName + '_' + rec.id);
  rec.folderId = f.getId();
  return f;
}

/* ---------------- 試算表 ---------------- */

function getSheet_() {
  let ss;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (!ss) throw new Error('請從試算表的「擴充功能 > Apps Script」建立此程式');
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
      .setFontWeight('bold').setBackground('#f4e3d3');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(COL['成品照片預覽'], 120);
    sheet.setColumnWidth(COL['文字食譜'], 300);
    sheet.hideColumns(COL['原始資料JSON']);
  }
  return sheet;
}

function findRow_(sheet, id) {
  if (!id) return -1;
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}

function countAttempts_(sheet, dishName, excludeId) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const data = sheet.getRange(2, 1, last - 1, COL['料理名稱']).getValues();
  const key = normalize_(dishName);
  return data.filter(function (r) {
    return normalize_(r[COL['料理名稱'] - 1]) === key && String(r[0]) !== String(excludeId);
  }).length;
}

function normalize_(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }

function toRow_(rec) {
  const first = (rec.finalPhotos || [])[0];
  const preview = first ? '=IMAGE("https://drive.google.com/thumbnail?id=' + first.fileId + '&sz=w400")' : '';
  const ingredients = (rec.ingredients || []).map(function (x) {
    return '・' + x.name + (x.amount ? '  ' + x.amount : '');
  }).join('\n');
  const steps = (rec.steps || []).map(function (s, i) {
    return (i + 1) + '. ' + s.text + (s.tip ? '（' + s.tip + '）' : '');
  }).join('\n');
  const map = {
    '紀錄ID': rec.id,
    '建立時間': rec.createdAt,
    '最後修改': rec.updatedAt,
    '料理日期': rec.date || '',
    '料理名稱': rec.dishName,
    '類別': rec.category || '',
    '第幾次做': rec.attempt || 1,
    '份量': rec.servings || '',
    '花費時間(分)': rec.timeMinutes || '',
    '評分': rec.rating ? '★'.repeat(rec.rating) + '☆'.repeat(5 - rec.rating) : '',
    '成品照片預覽': preview,
    '食材': ingredients,
    '步驟': steps,
    '成品心得': rec.resultNotes || '',
    '改進建議': rec.improvements || '',
    '下次調整': rec.nextTime || '',
    '標籤': (rec.tags || []).join(', '),
    '參考來源': rec.source || '',
    '文字食譜': rec.recipeText || '',
    '照片資料夾': rec.folderUrl || '',
    '原始資料JSON': JSON.stringify(rec)
  };
  return HEADERS.map(function (h) { return map[h]; });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
