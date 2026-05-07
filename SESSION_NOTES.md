# Session Notes — 2026-05-07

Lần làm việc này tập trung fix bug **ambiguous matching ở Ads tab** khi nhiều ad cùng tên (vd `MVideo 2003`) tồn tại ở nhiều campaign khác nhau và pill hiển thị data sai (aggregated hoặc của campaign khác).

## Bug chính đã giải quyết

### 1. Ambiguous fallback ở "All ads" view → pill aggregated cho mọi row trùng tên
**Triệu chứng**: ở tab Ads với filter `Ad name contains MVideo 2003`, tất cả row `MVideo 2003` đều hiện cùng pill `D0:31% 3d:34% 7d:34% All:34%` — đó là weighted-average ROAS của 12 campaign chứa ad này (Σ spend $104.96, khớp số "Total" ở Adjust).

**Root cause**: `lookupWithScope()` cũ chỉ disambiguate khi URL có `?selected_campaign_ids=ID` đơn lẻ. Trong "All ads" view URL không có scope → fallback về `entry.ambiguous` aggregate.

**Fix cuối cùng** ([content/meta-injector.js](content/meta-injector.js) — `lookupAmbiguousAware`): chuỗi 4 strategy theo thứ tự:
1. **URL scope** (`?selected_campaign_ids=ID` đơn lẻ)
2. **Meta preload JSON** ⭐ (đáng tin nhất — xem dưới)
3. **DOM Y-position row context** (tìm Campaign ID/name cell cùng Y)
4. **Ambiguous aggregate** (last resort)

### 2. Meta render markup khác nhau giữa các view/account
**Đã thử và FAIL**:
- `div.ellipsis` selector — chỉ catch 1 phần cell
- `div[style*="line-clamp"]` — return 0 elements ở account "Meta LPT 14"
- Walk-up DOM tìm row container — frozen-column layout phá vỡ

**Đã thử và OK một phần**: scan tất cả leaf elements (`*` với SKIP_TAGS = SCRIPT/STYLE/SVG/...) có text 5-300 chars. Universal hơn nhưng vẫn phụ thuộc cell visible trong viewport.

### 3. ⭐ Approach cuối cùng: parse Meta preload JSON
Meta Ads Manager nhúng **toàn bộ ad metadata** vào `<script>` tags trước khi render UI. Code parse 2 loại payload bằng regex:
- **Adgroup nodes**: `{node_id, ad_campaign_group_id, name}` → ad_id → campaign_id + ad_name
- **InsightsEdge rows**: `dimension_values=[obj, camp_name, camp_id, acct, ad_id, ...]` + `atomic_values=[spend, impressions, reach, ...]` → ad_id → spend

Build map `(name, spend) → campaign_id`. Mỗi row có cell `$X.XX` (Amount Spent) → tra map → ra exact campaign_id.

**Tại sao reliable**: spend trong Meta JSON và Meta UI cùng nguồn → khớp 100%. Không phụ thuộc DOM markup.

### 4. Cell `$X.XX` ambiguity (Amount Spent vs Cost Per Result)
**Triệu chứng**: row Ba Lan (campId 120249263328950779) hiển thị data Ita (45.67/58.49/58.51) — sai campaign.

**Root cause**: row có 2 cell `$X.XX` (Amount Spent + Cost Per Result). Code cũ pick cell ĐẦU TIÊN — nếu là Cost Per Result và coincidentally khớp Amount Spent của ad khác → wrong campId.

**Fix**: collect TẤT CẢ campIds từ mọi `$X.XX` cell trong row → chỉ resolve khi **chính xác 1 unique campId**. Nhiều match khác nhau → return null → fallback DOM Y-position hoặc ambiguous (an toàn hơn show data sai).

### 5. $0 spend collision trong Meta JSON
2 ad cùng tên cùng spend `"0"` (paused/no-delivery) → key `(name, $0.00)` collision → map overwrite, 1 ad luôn match sai campId.

**Fix**: khi build `bySpend` index, gặp key đã có với campId khác → đánh dấu sentinel `__AMBIGUOUS__`. Lookup gặp sentinel → skip (không trả về wrong campId).

### 6. Performance & UX
- **Delay khi load**: cũ chạy disambiguation 2 lần (decoration + diagnostic). Fix: track stats DURING decoration pass, diagnostic chỉ đọc lại — `lastDecorateStats`.
- **Universal `*` scan** vs targeted: phải scan all leaves vì Meta selector không stable → chấp nhận 50-100ms/cycle one-time.
- **Banner warning**: khi `stillAmbiguous > 0` banner hiện `⚠ N row(s) showing aggregate ROAS — enable "Campaign name" or "Campaign ID" column to disambiguate` (CSS `white-space: pre-line` để xuống dòng).

## Trạng thái hiện tại (account đã test)

Account "Meta LPT 11 - PlantAI", 12 ads `MVideo 2003*` visible:
- `ambiguous: 9` (5 × `MVideo 2003` + 2 × `MVideo 2003 SCALE` + 2 × `MVideo 2003 - Scale 04/11`)
- `resolvedByMetaPreload: 8`
- `resolvedByDom: 0`
- `resolvedByScope: 0`
- `stillAmbiguous: 1` (likely 1 row có $0 collision hoặc Adjust thiếu data cho cặp campaign+ad đó)

User confirm: "có vẻ chuẩn cho riêng account này rồi".

## Các vấn đề TỒN ĐỌNG (cần xử lý sau)

### A. Test thêm với account khác (Meta LPT 14 - DecorAI)
Account này render markup khác (selector `div[style*="line-clamp"]` return 0 elements). Cần verify fix Meta preload JSON cũng work với account đó. Nếu Meta load script payload khác format → phải mở rộng regex.

### B. Cell `$X.XX` virtualization
Nếu user scroll horizontal khiến cột Amount Spent bị virtualize off-screen → Meta preload không match (không có `$X.XX` cell trong DOM). Hiện fallback về DOM Y-position; nếu Campaign ID column visible → vẫn work. Nếu cả 2 columns đều off-screen → ambiguous fallback.

**Hướng fix tiềm năng**: cũng index theo `(name, impressions)` hoặc `(name, reach)` — atomic_values[1], [2] — multi-key matching. Khi 1 key thất bại, thử key khác.

### C. $0 collision genuine ambiguous
Khi 2 ad cùng tên cùng $0 spend (paused/new), Meta preload không thể disambiguate → ambiguous pill. Đây là LIMITATION không thể giải quyết bằng spend matching đơn thuần.

**Hướng fix tiềm năng**: thêm key `(name, ad_id)` nếu có cách extract Meta ad_id từ row DOM. Hiện không thấy ad_id stable trong row markup (chỉ có image URL với asset ID khác).

### D. Adjust và Meta spend lệch nhau
Adjust ($9.52) và Meta ($10.10) báo spend khác nhau cho cùng ad (data freshness lag). Fix hiện tại dùng Meta JSON spend (khớp UI) → resolve campId bằng Meta data → sau đó tra Adjust composite bằng campId (không dùng spend). Nên không bị ảnh hưởng. Nhưng nếu Adjust hoàn toàn thiếu data cho `(campaign, ad)` → composite lookup fail → fallback ambiguous.

### E. `urlScopedCampaignIds` size > 1
Khi user filter nhiều campaign cùng lúc (vd 23 campaigns), `lookupAmbiguousAware` chỉ xử lý `scope.size === 1`. Với multi-scope, có thể intersect candidates với scope set để narrow down — nhưng hiện chưa implement vì Meta preload đã đủ giải quyết.

### F. Refactor `creative_id_network` / `adgroup_id_network` từ Adjust
Đã capture `campaign_id_network` từ `attr_dependency`. Adjust API có thể trả thêm `creative_id_network` (Meta ad_id) và `adgroup_id_network` (Meta adset_id). Nếu capture được → match ad_id trực tiếp với Meta JSON node_id (eliminate cần spend matching).

**Vị trí**: [src/adjust-client.js:139](src/adjust-client.js:139) — `toRow()`.

### G. Decoration tốc độ trên page lớn
`document.querySelectorAll('*')` trên page Meta có thể return 10k-30k elements. Bucket build mỗi cycle ~50-100ms. MutationObserver debounce 200ms nên chấp nhận được nhưng có thể tối ưu thêm:
- Cache bucket cho `parsedAt` window 30s (giống Meta preload index)
- Hoặc invalidate bucket chỉ khi mutation thực sự thay đổi rows (hiện invalidate mọi mutation)

### H. UX: phân biệt "ambiguous" vs "no Adjust data"
Khi Meta preload resolve campId nhưng Adjust composite không có data cho `(campId, adName)` → hiện hiển thị ambiguous pill (totals across duplicates). Thực ra trường hợp này là "Adjust thiếu data" chứ không phải ambiguous → nên hiện pill khác (vd "—" hoặc tooltip rõ "No Adjust data for this exact campaign+ad combo").

## Files quan trọng

- [content/meta-injector.js](content/meta-injector.js) — toàn bộ logic mới (parse Meta preload, Y-bucket, lookup chain)
- [content/meta-injector.css](content/meta-injector.css) — `white-space: pre-line` cho banner multi-line
- [src/adjust-client.js](src/adjust-client.js) — `attr_dependency.campaign_id_network` capture
- [src/matcher.js](src/matcher.js) — Unicode-safe normalization (không thay đổi session này)
- [background.js](background.js) — cache + sync (không thay đổi session này)

## Diagnostic commands hữu dụng (paste vào DevTools Console)

### Liệt kê Meta preload data cho ad name
```js
(() => {
  const re = /"node_id":"(\d+)"[^{}]*?"ad_campaign_group_id":"(\d+)"[^{}]*?"name":"((?:[^"\\]|\\.)*)"/g;
  const re2 = /"dimension_values":\["[^"]*","(?:[^"\\]|\\.)*","(\d+)","\d+","(\d+)","[^"]*","[^"]*"\],"atomic_values":\["([^"]+)"/g;
  const ads = [], spends = new Map();
  for (const s of document.querySelectorAll('script')) {
    const t = s.textContent || '';
    if (t.length < 500) continue;
    let m;
    re.lastIndex = 0; while ((m = re.exec(t)) !== null) ads.push({adId: m[1], campId: m[2], name: m[3]});
    re2.lastIndex = 0; while ((m = re2.exec(t)) !== null) spends.set(m[2], m[3]);
  }
  return ads.filter(a => a.name.includes('MVideo 2003')).map(a => ({...a, spend: spends.get(a.adId)}));
})()
```

### Check `$X.XX` cells trong row của ad
```js
(() => {
  const ad = [...document.querySelectorAll('div.ellipsis')].find(e => e.textContent.trim() === 'MVideo 2003');
  if (!ad) return 'no ad';
  const r = ad.getBoundingClientRect();
  let bestRect = r, n = ad.parentElement;
  for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
    const nr = n.getBoundingClientRect();
    if (nr.height === 0 || nr.height > 200) continue;
    if (nr.height > bestRect.height) bestRect = nr;
  }
  const cells = [];
  document.querySelectorAll('*').forEach(el => {
    if (el.children.length > 0) return;
    const t = (el.textContent || '').trim();
    if (!t) return;
    const er = el.getBoundingClientRect();
    if (er.height === 0) return;
    const mid = (er.top + er.bottom) / 2;
    if (mid < bestRect.top - 2 || mid > bestRect.bottom + 2) return;
    cells.push({tag: el.tagName, text: t.slice(0, 50)});
  });
  return cells;
})()
```
