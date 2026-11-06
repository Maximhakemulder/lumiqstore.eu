-- De houtserie (1201-1204) is uit het assortiment. De nieuwe LED-kaars Model C wordt serie 1200, model 1201.
UPDATE producten SET actief = FALSE, afbeelding = '', code = code || '-hout', notities = 'Uit het assortiment (6-11-2026)' WHERE serie = '1200' AND code IN ('1201','1202','1203','1204');
UPDATE producten SET serie = '1200', code = '1201', afbeelding = '/media/collectie/p1201.jpg' WHERE code = '1301';
