-- NIEUW (6-11-2026): LED-kaars Model C, verkocht per set van 12 kaarsen met inductielader (12 plekken).
-- Bediening met afstandsbediening (geen app/wifi). Prijzen vult Maxim in HQ › Producten.
INSERT INTO producten (serie, code, naam, stijl, maat, materiaal, leverancier_code, afbeelding, moq, notities) VALUES
('1300','1301','Kaars C (set van 12 + inductielader)','Kaars','H57 x Ø39mm','ABS','C','/media/collectie/p1301.jpg',1,
 'Per set van 12 kaarsen met inductielader (12 plekken). 3,2V 350mAh, laden 8-9 uur, 15-16 uur licht, IP54. 2700-4000K warm wit, ook RGB/amber. Afstandsbediening, geen app of wifi. Prijs en inkoop per set invullen.')
ON CONFLICT (code) DO NOTHING;
