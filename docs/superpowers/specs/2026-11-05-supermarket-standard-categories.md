# Standard categories of a supermarket / hypermarket

Owner request (2026-11-05): create all the categories found in hypermarkets, shown as picture buttons in the till.

## Decision
- A fixed starter tree lives in the Supermarket pack as data (`key`, ar, en, ckb, optional children). It is NOT written to any database by this change.
- It is created per business by an idempotent action "Add the standard categories": a category is skipped when the business already has one with the same Arabic name (archived ones included). New Supermarket shops get it at creation; the existing shop Rizgar gets it only when the owner presses the button (preview list first, then confirm). Nothing is created silently in production.
- The till shows the top-level departments as picture tiles (illustration chosen by `key`, never by guessing from the name for these); children appear as sub-chips inside a department. Departments with no items are hidden from the till tiles.
- Kurdish (ckb) names are a first draft and need a native speaker's review before release.

## Tree (top level, then children)

1. dairy / ألبان وأجبان: milk, yogurt and laban, cheese, butter and cream, eggs
2. bakery / مخبوزات: bread, pastries, cakes, biscuits
3. fruit_veg / خضار وفواكه: vegetables, fruits, herbs, dates and dried fruit
4. meat_poultry / لحوم ودجاج: red meat, chicken, minced meat, processed meat
5. fish / أسماك ومأكولات بحرية
6. frozen / مجمدات: frozen vegetables, frozen meat, ice cream, ready frozen meals
7. staples / مواد غذائية أساسية: rice, flour, sugar and salt, pasta and noodles, lentils and beans, oil and ghee
8. canned / معلبات: canned vegetables, canned fish, tomato paste and sauces, jam and honey, pickles
9. spices / بهارات وتوابل
10. breakfast / إفطار وحبوب: cereals, spreads, tahini and halawa
11. snacks / وجبات خفيفة: chips, nuts, chocolate, candy and gum
12. sweets / حلويات وسكاكر
13. tea_coffee / شاي وقهوة: tea, coffee, instant drinks, sugar cubes
14. beverages / مشروبات: water, soft drinks, juices, energy drinks
15. cleaning / منظفات: laundry, dishwashing, surface cleaners, tissues and paper, bags and foil
16. personal_care / عناية شخصية: shampoo and soap, dental care, deodorant and perfume, shaving, feminine care
17. baby / أطفال: diapers, baby food and milk, baby care
18. pet / مستلزمات الحيوانات الأليفة
19. household / أدوات منزلية: kitchenware, plastic ware, light bulbs and batteries, disposable tableware
20. stationery / قرطاسية وألعاب: school supplies, toys
21. health / صحة وفيتامينات: vitamins, first aid
22. tobacco / تبغ وكبريت (only where the business enables it)
23. other / أخرى

## For the illustration set (till tiles)
One illustration per `key` above (23). Fallback illustration for any category the owner adds himself, picked by keywords as already specified.

## Tests
Seeding twice creates nothing the second time; an existing category with the same Arabic name is reused; archived ones are not recreated; children link to the right parent; the action is limited to the owner role and one business; word guard for the new names.
