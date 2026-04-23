// ═══════════════════════════════════════════════════════════════
// SEED SCRIPT — Run this in the browser console while logged in 
// as sterling.al11@gmail.com on shoptrack.org
// ═══════════════════════════════════════════════════════════════
(async function(){
  if(!SESSION.bizId){ console.error('Not logged in!'); return; }
  var bizId = SESSION.bizId;
  var items = [
    {id:'EL-0001',sku:'IPH-15PM',name:'iPhone 15 Pro Max 256GB',cat:'Mobile Phones',brand:'Apple',st:'For Sale',cond:'New',cost:550000/CUR.rate,sp:750000/CUR.rate,rp:15000/CUR.rate,dep:50000/CUR.rate,qty:5,color:'Natural Titanium',sz:'',desc:'Apple iPhone 15 Pro Max with A17 Pro chip, 48MP camera system, titanium design. 256GB storage.'},
    {id:'EL-0002',sku:'SAM-S24U',name:'Samsung Galaxy S24 Ultra 256GB',cat:'Mobile Phones',brand:'Samsung',st:'For Sale',cond:'New',cost:480000/CUR.rate,sp:680000/CUR.rate,rp:12000/CUR.rate,dep:50000/CUR.rate,qty:4,color:'Titanium Black',sz:'',desc:'Samsung Galaxy S24 Ultra with S Pen, 200MP camera, Snapdragon 8 Gen 3. 256GB.'},
    {id:'EL-0003',sku:'SAM-A55',name:'Samsung Galaxy A55 5G 128GB',cat:'Mobile Phones',brand:'Samsung',st:'For Sale',cond:'New',cost:145000/CUR.rate,sp:215000/CUR.rate,rp:5000/CUR.rate,dep:20000/CUR.rate,qty:8,color:'Awesome Iceblue',sz:'',desc:'Samsung Galaxy A55 5G with Super AMOLED display, 50MP triple camera, 5000mAh battery.'},
    {id:'EL-0004',sku:'TEC-SP20',name:'Tecno Spark 20 Pro+ 256GB',cat:'Mobile Phones',brand:'Tecno',st:'For Sale',cond:'New',cost:85000/CUR.rate,sp:135000/CUR.rate,rp:3000/CUR.rate,dep:15000/CUR.rate,qty:12,color:'Magic Skin Blue',sz:'',desc:'Tecno Spark 20 Pro+ with 108MP camera, 8GB RAM, 5000mAh fast charge.'},
    {id:'EL-0005',sku:'IPH-14',name:'iPhone 14 128GB',cat:'Mobile Phones',brand:'Apple',st:'For Sale',cond:'New',cost:380000/CUR.rate,sp:520000/CUR.rate,rp:10000/CUR.rate,dep:40000/CUR.rate,qty:6,color:'Midnight',sz:'',desc:'Apple iPhone 14 with A15 Bionic chip, dual camera system, Crash Detection. 128GB.'},
    {id:'EL-0006',sku:'RED-N13P',name:'Redmi Note 13 Pro 256GB',cat:'Mobile Phones',brand:'Xiaomi',st:'For Sale',cond:'New',cost:110000/CUR.rate,sp:175000/CUR.rate,rp:4000/CUR.rate,dep:15000/CUR.rate,qty:10,color:'Midnight Black',sz:'',desc:'Xiaomi Redmi Note 13 Pro with 200MP camera, AMOLED display, 67W fast charge.'},
    {id:'EL-0007',sku:'INF-N40',name:'Infinix Note 40 Pro 256GB',cat:'Mobile Phones',brand:'Infinix',st:'For Sale',cond:'New',cost:95000/CUR.rate,sp:155000/CUR.rate,rp:3500/CUR.rate,dep:15000/CUR.rate,qty:7,color:'Titan Gold',sz:'',desc:'Infinix Note 40 Pro with wireless charging, AMOLED display, 108MP camera.'},
    {id:'EL-0008',sku:'MBP-M3P',name:'MacBook Pro 14" M3 Pro 512GB',cat:'Laptops',brand:'Apple',st:'For Sale',cond:'New',cost:1100000/CUR.rate,sp:1450000/CUR.rate,rp:25000/CUR.rate,dep:100000/CUR.rate,qty:3,color:'Space Black',sz:'14"',desc:'Apple MacBook Pro 14-inch with M3 Pro chip, 18GB RAM, 512GB SSD. Liquid Retina XDR display.'},
    {id:'EL-0009',sku:'MBP-AIR',name:'MacBook Air 13" M2 256GB',cat:'Laptops',brand:'Apple',st:'For Sale',cond:'New',cost:650000/CUR.rate,sp:850000/CUR.rate,rp:18000/CUR.rate,dep:80000/CUR.rate,qty:4,color:'Starlight',sz:'13.6"',desc:'Apple MacBook Air 13-inch with M2 chip, 8GB RAM, 256GB SSD. Fanless design, MagSafe charging.'},
    {id:'EL-0010',sku:'HP-PAV15',name:'HP Pavilion 15 i5/8GB/512GB',cat:'Laptops',brand:'HP',st:'For Sale',cond:'New',cost:320000/CUR.rate,sp:450000/CUR.rate,rp:10000/CUR.rate,dep:50000/CUR.rate,qty:5,color:'Natural Silver',sz:'15.6"',desc:'HP Pavilion 15 with Intel Core i5, 8GB RAM, 512GB SSD, Full HD IPS display.'},
    {id:'EL-0011',sku:'LEN-IP3',name:'Lenovo IdeaPad 3 i5/8GB/256GB',cat:'Laptops',brand:'Lenovo',st:'For Sale',cond:'New',cost:280000/CUR.rate,sp:385000/CUR.rate,rp:8000/CUR.rate,dep:40000/CUR.rate,qty:6,color:'Arctic Grey',sz:'15.6"',desc:'Lenovo IdeaPad 3 with Intel Core i5-1235U, 8GB RAM, 256GB SSD. Dolby Audio.'},
    {id:'EL-0012',sku:'DEL-INS',name:'Dell Inspiron 15 3520 i3/8GB/256GB',cat:'Laptops',brand:'Dell',st:'For Sale',cond:'New',cost:220000/CUR.rate,sp:320000/CUR.rate,rp:7000/CUR.rate,dep:30000/CUR.rate,qty:4,color:'Carbon Black',sz:'15.6"',desc:'Dell Inspiron 15 with Intel Core i3, 8GB RAM, 256GB SSD. Budget-friendly laptop.'},
    {id:'EL-0013',sku:'APD-PRO',name:'AirPods Pro 2nd Gen USB-C',cat:'Accessories',brand:'Apple',st:'For Sale',cond:'New',cost:85000/CUR.rate,sp:145000/CUR.rate,rp:3000/CUR.rate,dep:10000/CUR.rate,qty:15,color:'White',sz:'',desc:'Apple AirPods Pro 2nd generation with USB-C, Active Noise Cancellation, Adaptive Audio.'},
    {id:'EL-0014',sku:'SAM-BDS',name:'Samsung Galaxy Buds3 Pro',cat:'Accessories',brand:'Samsung',st:'For Sale',cond:'New',cost:65000/CUR.rate,sp:110000/CUR.rate,rp:2500/CUR.rate,dep:8000/CUR.rate,qty:10,color:'Silver',sz:'',desc:'Samsung Galaxy Buds3 Pro with intelligent ANC, 360 Audio, blade design. IPX7 water resistant.'},
    {id:'EL-0015',sku:'JBL-FL6',name:'JBL Flip 6 Bluetooth Speaker',cat:'Accessories',brand:'JBL',st:'For Sale',cond:'New',cost:45000/CUR.rate,sp:75000/CUR.rate,rp:2000/CUR.rate,dep:5000/CUR.rate,qty:8,color:'Black',sz:'',desc:'JBL Flip 6 portable Bluetooth speaker with powerful sound, IP67 waterproof, 12-hour battery.'},
    {id:'EL-0016',sku:'APW-S9',name:'Apple Watch Series 9 45mm',cat:'Wearables',brand:'Apple',st:'For Sale',cond:'New',cost:250000/CUR.rate,sp:375000/CUR.rate,rp:5000/CUR.rate,dep:30000/CUR.rate,qty:4,color:'Midnight Aluminium',sz:'45mm',desc:'Apple Watch Series 9 with S9 chip, double tap gesture, bright Always-On display. GPS.'},
    {id:'EL-0017',sku:'LOG-MX3',name:'Logitech MX Master 3S Mouse',cat:'Accessories',brand:'Logitech',st:'For Sale',cond:'New',cost:35000/CUR.rate,sp:55000/CUR.rate,rp:0,dep:0,qty:12,color:'Graphite',sz:'',desc:'Logitech MX Master 3S wireless mouse with 8K DPI sensor, quiet clicks, USB-C, multi-device.'},
    {id:'EL-0018',sku:'ANK-PB2',name:'Anker PowerCore 20000mAh',cat:'Accessories',brand:'Anker',st:'For Sale',cond:'New',cost:18000/CUR.rate,sp:32000/CUR.rate,rp:1000/CUR.rate,dep:3000/CUR.rate,qty:20,color:'Black',sz:'',desc:'Anker PowerCore 20000mAh portable charger with dual USB-A output, PowerIQ, for phones & tablets.'},
    {id:'EL-0019',sku:'IPD-A13',name:'iPad Air 13" M2 128GB WiFi',cat:'Tablets',brand:'Apple',st:'For Sale',cond:'New',cost:480000/CUR.rate,sp:650000/CUR.rate,rp:12000/CUR.rate,dep:50000/CUR.rate,qty:3,color:'Space Grey',sz:'13"',desc:'Apple iPad Air 13-inch with M2 chip, Liquid Retina display, USB-C, supports Apple Pencil Pro.'},
    {id:'EL-0020',sku:'SAM-TS9',name:'Samsung Galaxy Tab S9 FE 128GB',cat:'Tablets',brand:'Samsung',st:'For Sale',cond:'New',cost:195000/CUR.rate,sp:295000/CUR.rate,rp:6000/CUR.rate,dep:25000/CUR.rate,qty:5,color:'Gray',sz:'10.9"',desc:'Samsung Galaxy Tab S9 FE with S Pen included, IP68 water resistant, 10.9" display, 128GB.'},
  ];

  // Add categories
  var cats = ['Mobile Phones','Laptops','Accessories','Wearables','Tablets'];
  cats.forEach(function(c){ if(D.invCats.indexOf(c)===-1) D.invCats.push(c); });
  _dbSaveCategories(bizId);

  // Add items to D.inv and save each
  var saved = 0;
  for(var i=0; i<items.length; i++){
    var it = items[i];
    it.rented = 0;
    it.minSp = 0;
    it.minStock = 2;
    it.img = 'gown-aline';
    it.imgC = ['#a8b4c8','#c8b4a0','#e0d4bc'];
    it.imgDataUrl = null;
    it.photoDataUrls = [];
    // Check if already exists
    if(!D.inv.find(function(x){return x.id===it.id;})){
      D.inv.push(it);
    }
    try{
      await _safeUpsert('inventory', _invToDB(it, bizId), 'seed-'+it.id);
      saved++;
      console.log('✅ Saved: ' + it.name);
    }catch(e){
      console.error('❌ Failed: ' + it.name, e.message);
    }
  }
  // Save to IDB cache
  await _idbSave(bizId, 'inv', D.inv);
  console.log('🎉 Done! Saved ' + saved + '/' + items.length + ' items');
  toast('✅ ' + saved + ' electronics products added!', 'success');
  nav('inventory');
})();
