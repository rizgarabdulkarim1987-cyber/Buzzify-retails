# Standard departments: Electronics and Clothing

Owner request (2026-11-05): "the same" for Clothing and Electronics as for the Supermarket: the new till (ticket-first layout, parallel sales,
barcode on top, department cards, buzzify.me look in dark and light, USD/IQD design). The till, the theme tokens and the keypad are shared
code, so both products inherit them. What is per product is below. Same rules as the supermarket spec: data in the pack, not written to any
database by this change; created per business by the idempotent "Add the standard categories" action (preview, then confirm; skip a name that exists);
new shops get it at creation; ckb names are a first draft for native review.

## Electronics (key / ar / en; children)
1. phones / هواتف: smartphones, feature phones, tablets
2. phone_accessories / ملحقات الهواتف: cases, screen protectors, chargers and cables, power banks, earphones and headphones, holders
3. computers / حواسيب: laptops, desktops, monitors, printers and ink, storage and memory
4. computer_accessories / ملحقات الحاسوب: keyboards and mice, bags, webcams, USB hubs
5. gaming / ألعاب فيديو: consoles, controllers, games, gaming accessories
6. tv_audio / تلفزيونات وصوتيات: TVs, speakers and soundbars, receivers, remotes
7. smart_devices / أجهزة ذكية: smart watches, trackers, smart home
8. cameras / كاميرات: cameras, security cameras, drones, memory cards
9. networking / شبكات: routers, extenders, cables, switches
10. power / طاقة وبطاريات: batteries, UPS and stabilizers, solar chargers, extension cords
11. small_appliances / أجهزة منزلية صغيرة: fans, heaters, kettles, irons
12. sim_credit / شرائح ورصيد: SIM cards, top-up cards
13. spare_parts / قطع غيار: screens, batteries, boards, tools
14. other / أخرى

## Clothing (key / ar / en; children)
1. women / نسائي: dresses, tops, trousers and skirts, abayas and modest wear, scarves and hijab, nightwear
2. men / رجالي: shirts, trousers, suits and jackets, traditional wear (dishdasha), t-shirts and polo
3. kids / أطفال: boys, girls, school wear
4. baby / رضّع: bodysuits, sets, blankets
5. shoes / أحذية: women, men, kids, sandals and slippers, sports shoes
6. bags / حقائب: handbags, backpacks, travel bags, wallets
7. accessories / إكسسوارات: belts, hats and caps, scarves, sunglasses, jewellery, watches
8. underwear / ملابس داخلية وجوارب: men, women, kids, socks
9. sportswear / ملابس رياضية: tracksuits, sports tops, swimwear
10. outerwear / ملابس شتوية: coats, jackets, sweaters, gloves and scarves
11. perfumes / عطور وعناية: perfumes, body care
12. fabrics / أقمشة ومستلزمات خياطة
13. other / أخرى

## What the till needs per product (small)
- One line glyph and one accent per key (the same card component and the 14 accents; fixed accent per key, hash fallback for owner-made names).
- Words: "departments", item words and the "Open" label come from the pack's own words file; no supermarket wording (the word guard enforces it).
- Sell screen opens with the product's departments; nothing from another product is reachable.

## Not part of "the same" (the real product features, next in the roadmap)
- Electronics: IMEI/serial entry at sale and never selling one twice, warranty, repairs, installments, trade-in.
- Clothing: size and colour matrix (create in one go), a barcode per variant, size/colour picker in the till, exchange.
These need their own design, schema changes and tests; they are separate slices after accounting.

## Tests
Both trees seed idempotently and link children to the right parent; every key has a glyph and an accent passing AA in both themes; the word guard passes for both packs in ar, ckb and en; a pack never lists another pack's departments.
