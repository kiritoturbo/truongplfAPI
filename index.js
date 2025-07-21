const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const { PromisePool } = require('@supercharge/promise-pool');
const dayjs = require('dayjs'); 
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const moment = require('moment-timezone');

const app = express();
const PORT = process.env.PORT || 8886;
// 🔧 Cấu hình
const DB_CONFIG = {
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'truongplfnew',
  charset: 'utf8mb4'
};
// const DB_CONFIG = {
//   host: '113.192.8.160', // IP của VPS
//   user: 'admin_larvps',
//   password: 'OTM2NDIyZGYzODk5NTc2MjcyOTUwZTVi',
//   database: 'backuptruestoreusy2r_db',
//   port: 3306, // default của MySQL
//  charset: 'utf8mb4'
// };

// async function testMysqlConnection() {
//   try {
//     const connection = await mysql.createConnection(DB_CONFIG);

//     console.log('✅ Kết nối MySQL thành công!');
    
//     const [rows] = await connection.execute('SELECT * FROM wp_salesreport where date="2025-01-11"');
//     console.log(rows)
//     console.log('⏰ Thời gian hiện tại từ MySQL:', rows[0].date);

//     await connection.end();
//   } catch (error) {
//     console.error('❌ Kết nối MySQL thất bại:', error.message);
//   }
// }

// testMysqlConnection();

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));



app.get('/api/clone-missing-products-batch', async (req, res) => {
  const target_ids = [
    39714, 39933, 40308, 40214, 29890, 29750, 33780,
    31633, 30825, 32136, 35168, 32423, 31120, 35538,
    36408, 32685, 39818, 33371, 36404, 36017, 29801,
    31092, 32461, 39788, 35705, 32933, 30701, 28907,
    26321, 31773
  ];

  let domains = [];
  const requestedDomain = req.query.domain?.toLowerCase();
  
  try {
    // const wpResponse = await axios.get('https://truestore.us/wp-json/api/v1/getdomainaddproduct', {
    //   timeout: 10000
    // });
    const getDomainApiUrl = requestedDomain
    ? `https://truestore.us/wp-json/api/v1/getdomainaddproduct?domain=${encodeURIComponent(requestedDomain)}`
    : `https://truestore.us/wp-json/api/v1/getdomainaddproduct`;

    const wpResponse = await axios.get(getDomainApiUrl, {
      timeout: 10000
    });
    if (wpResponse.data.success && Array.isArray(wpResponse.data.data)) {
      domains = wpResponse.data.data;
    } else {
      return res.status(400).json({ success: false, message: 'API trả về không hợp lệ' });
    }
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Lỗi gọi API domain', error: err.message });
  }

  
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const report = [];

  const { results } = await PromisePool
    .withConcurrency(10)
    .for(domains)
    .process(async row => {
      const { madomain, domain } = row;

      try {
        const api_url = `https://api-catalog-service.truestore.vn/api/domain/${madomain}/products?limit=100`;
        const productRes = await axios.get(api_url);
        const data = productRes.data;

        if (!data.products || !Array.isArray(data.products)) {
          console.log(`⚠️ Không có sản phẩm cho domain: ${domain}`);
          report.push({ domain, cloned: 0, skipped: target_ids.length });
          return;
        }

        const existing_ids = data.products.map(p => p.parent_id);
        const missing_ids = target_ids.filter(id => !existing_ids.includes(id));

        let clonedCount = 0;

        for (const missing_id of missing_ids) {
          const clone_url = `https://api-catalog-service.truestore.vn/api/clone-product?domain=${madomain}&product_id=${missing_id}`;
          try {
            await axios.get(clone_url);
            console.log(`✅ Cloned ID ${missing_id} → ${domain}`);
            clonedCount++;
          } catch (e) {
            console.error(`❌ Clone thất bại ID ${missing_id} → ${domain}: ${e.message}`);
          }
          await sleep(500);
        }

        report.push({ domain, cloned: clonedCount, skipped: target_ids.length - clonedCount });
      } catch (err) {
        console.error(`❌ Lỗi xử lý domain ${domain}: ${err.message}`);
        report.push({ domain, error: err.message });
      }
    });

  res.json({
    success: true,
    message: `✅ Đã xử lý xong ${domains.length} domain`,
    report
  });
});
app.post('/api/delete-all-products', async (req, res) => {
  const { domain: requestedDomain } = req.body;

  if (!requestedDomain) {
    return res.status(400).json({ success: false, message: 'Missing domain' });
  }

  try {
    // 1. Lấy madomain và domain từ API WordPress
    const domainInfoRes = await axios.get(`https://truestore.us/wp-json/api/v1/getdomainaddproduct?domain=${encodeURIComponent(requestedDomain)}`);
    const domainInfo = domainInfoRes.data?.data?.[0];

    if (!domainInfo || !domainInfo.madomain) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy madomain cho domain này' });
    }

    const madomain = domainInfo.madomain;
    const domain = domainInfo.domain;
   

    // 2. Lấy danh sách sản phẩm
    const getProductsUrl = `https://api-catalog-service.truestore.vn/api/domain/${madomain}/products?limit=100`;
    const productListRes = await axios.get(getProductsUrl);
    const products = productListRes.data?.products || [];

    if (products.length === 0) {
      return res.json({ success: true, message: `Không có sản phẩm nào trong domain ${domain}` });
    }

    // 3. Xóa từng sản phẩm
    let deletedCount = 0;
    for (const product of products) {
      if (!product.id) continue;

      const deleteUrl = `https://api-catalog-service.truestore.vn/api/domain/${madomain}/products/${product.id}`;

      try {
        await axios.delete(deleteUrl, {
          headers: {
            'Content-Type': 'application/json',
            // Authorization: 'Bearer your_token_here' // nếu có auth
          }
        });
        deletedCount++;
      } catch (err) {
        console.error(`Lỗi xóa sản phẩm ID ${product.id}:`, err.message);
      }
    }

    res.json({
      success: true,
      message: `Đã xóa ${deletedCount} sản phẩm trong domain ${domain}`,
      domain,
      deleted: deletedCount
    });

  } catch (error) {
    console.error('Lỗi khi xử lý xóa:', error.message);
    res.status(500).json({ success: false, message: 'Có lỗi xảy ra khi xử lý' });
  }
});

function getYesterdayDateUTCMinus7() {
  const nowInUTCMinus7 = moment.tz('Etc/GMT+7');

  return nowInUTCMinus7.format('DD-MM-YYYY');
}


const API_URL = 'http://localhost:8886/api/sale-firebase-summary'; // 🔁 Đổi thành URL thật của bạn

cron.schedule('*/2 * * * *', async () => {
  const dateStr = getYesterdayDateUTCMinus7();
// &domain=minimalistdaily.com
  try {
    const { data } = await axios.get(`${API_URL}?date=${dateStr}`);
    if (!data.success || !Array.isArray(data.data)) {
      console.log(`[${new Date().toISOString()}] ❌ Dữ liệu không hợp lệ`);
      return;
    }

    const conn = await mysql.createConnection(DB_CONFIG);

    for (const item of data.data) {
      if (item.error) {
        console.warn(`⚠️ Lỗi từ domain ${item.domain}: ${item.message}`);
        continue;
      }

      const {
        domain,
        date,
        orders = 0,
        money = 0,
        total_view = 0,
        total_atc = 0,
        total_checkout = 0,
        device_mobile=0,
        device_tablet=0,
        device_pc=0,
        currency = '',
        products = [],
      } = item;
      

      const stats = JSON.stringify(products);
      const utmUrl = `http://localhost:8886/api/sale-firebase-camp-summary?date=${dateStr}&domain=${domain}`;
      let statsUTM = '';

      try {
        const { data: utmData } = await axios.get(utmUrl);
        if (utmData.success && utmData.data) {
          const mergedUTM = [];

          // for (const platform of Object.keys(utmData.data)) {
          //   const paid = utmData.data[platform]?.paid || {};
          //   for (const level1 of Object.values(paid)) {
          //     for (const level2 of Object.values(level1)) {
          //       for (const level3 of Object.values(level2)) {
          //         mergedUTM.push({
          //           platform,
          //           ...level3,
          //         });
          //       }
          //     }
          //   }
          // }

          statsUTM = JSON.stringify(utmData.data);
        } else {
          console.warn(`⚠️ Không có dữ liệu UTM hợp lệ cho domain ${domain}`);
        }
      } catch (e) {
        console.warn(`⚠️ Lỗi lấy UTM cho ${domain}:`, e.message);
      }

      const [existing] = await conn.execute(
        'SELECT id FROM wp_salesreport WHERE domain = ? AND date = ?',
        [domain, date]
      );

      if (existing.length === 0) {
        await conn.execute(
          `INSERT INTO wp_salesreport 
            (domain, date, orders, money, view, atc, checkout, Stats, StatsUTM, currency,totalPC,totalTablet,totalMobile)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,?,?,?)`,
          [domain, date, orders, money, total_view, total_atc, total_checkout, stats, statsUTM, currency,device_pc,device_tablet,device_mobile]
        );
        console.log(`✅ Inserted: ${domain} (${date})`);
      } else {
        await conn.execute(
          `UPDATE wp_salesreport SET 
            orders = ?, money = ?, view = ?, atc = ?, checkout = ?, Stats = ?, StatsUTM = ?, currency = ?,totalPC= ?,totalTablet= ?,totalMobile= ?
           WHERE domain = ? AND date = ?`,
          [orders, money, total_view, total_atc, total_checkout, stats, statsUTM, currency,device_pc,device_tablet,device_mobile, domain, date]
        );
        console.log(`♻️ Updated: ${domain} (${date})`);
      }
    }

    await conn.end();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Lỗi: `, err.message);
  }
}, {
  timezone: 'UTC'
});













// app.get('/api/summary-firebase-stats', async (req, res) => {
//   const { date } = req.query;

//   if (!date) {
//     return res.status(400).json({ success: false, message: 'Missing date (ex: 7-11-2025)' });
//   }

//   let domains = [];

//   try {
//     const wpResponse = await axios.get('https://truestore.us/wp-json/api/v1/getdomainaddproduct', {
//       timeout: 10000
//     });

//     if (wpResponse.data.success && Array.isArray(wpResponse.data.data)) {
//       domains = wpResponse.data.data;
//     } else {
//       return res.status(400).json({ success: false, message: 'API trả về không hợp lệ' });
//     }
//   } catch (err) {
//     return res.status(500).json({ success: false, message: 'Lỗi gọi API domain', error: err.message });
//   }

//   const results = [];

//   const { results: domainStats } = await PromisePool
//     .withConcurrency(15)
//     .for(domains)
//     .process(async ({ domain }) => {
//       const domainKey = domain.replace(/\./g, 'DV');
//       const firebaseUrl = `https://king-fruit-slot.firebaseio.com/${domainKey}/PUB2/${date}.json`;

//       try {
//         const response = await axios.get(firebaseUrl, { timeout: 8000 });
//         const data = response.data;

//         let totalView = 0, totalATC = 0, totalCheckout = 0;
//         const products = [];

//         for (const pid in data) {
//           const item = data[pid];

//           const vcCount = item.VC ? Object.keys(item.VC).length : 0;
//           const atcCount = item.ATC ? Object.keys(item.ATC).length : 0;
//           const coCount = item.CO5 ? Object.keys(item.CO5).length : 0;

//           totalView += vcCount;
//           totalATC += atcCount;
//           totalCheckout += coCount;

//           products.push({
//             product_id: pid,
//             view: vcCount,
//             atc: atcCount,
//             checkout: coCount,
//             name: item.NAME || '',
//             link: item.LK || '',
//             thumb: item.TB || ''
//           });
//         }

//         results.push({
//           domain,
//           total_view: totalView,
//           total_atc: totalATC,
//           total_checkout: totalCheckout,
//           products
//         });

//       } catch (err) {
//         console.error(`❌ Firebase error for ${domain}: ${err.message}`);
//         results.push({ domain, error: true, message: err.message });
//       }
//     });

//   return res.json({
//     success: true,
//     date,
//     total_domains: results.length,
//     data: results
//   });
// });
// //get dữ liệu có tính trước GBP
// app.get('/api/sale-firebase-summary', async (req, res) => {
//   const { date, domain: domainQuery } = req.query;

//   if (!date) {
//     return res.status(400).json({ success: false, message: 'Missing date (ex: 10-07-2025)' });
//   }

//   // Parse date theo định dạng DD-MM-YYYY
//   const [dayStr, monthStr, yearStr] = date.split('-');
//   const day = parseInt(dayStr, 10);
//   const month = parseInt(monthStr, 10); // tháng tính từ 1-12
//   const year = parseInt(yearStr, 10);

//   const d = new Date(year, month - 1, day);
//   if (isNaN(d.getTime())) {
//     return res.status(400).json({ success: false, message: 'Invalid date format (expected DD-MM-YYYY)' });
//   }

//   const pad = (n) => (n < 10 ? `0${n}` : n);

//   // ✅ Firebase dùng dạng D-M-YYYY (ko pad số 0)
//   const firebaseDate = `${d.getMonth() + 1}-${d.getDate()}-${d.getFullYear()}`;

//   // ✅ Sale Report dùng DD-MM-YYYY (có pad 0)
//   const saleReportDate = `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;

//   // ✅ Trả về cho client dạng YYYY-MM-DD
//   const returnDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
//   // console.log(firebaseDate)
//   // console.log(saleReportDate)
//   let domains = [];

//   try {
//     const wpResponse = await axios.get('https://truestore.us/wp-json/api/v1/getdomainaddproduct', {
//       timeout: 10000
//     });

//     if (wpResponse.data.success && Array.isArray(wpResponse.data.data)) {
//       domains = wpResponse.data.data;
//     } else {
//       return res.status(400).json({ success: false, message: 'API trả về không hợp lệ' });
//     }
//   } catch (err) {
//     return res.status(500).json({ success: false, message: 'Lỗi gọi API domain', error: err.message });
//   }

//   // Nếu có truyền domain thì chỉ xử lý domain đó
//   if (domainQuery) {
//     const found = domains.find(d => d.domain === domainQuery);
//     if (!found) {
//       return res.status(404).json({ success: false, message: `Domain '${domainQuery}' không tồn tại trong hệ thống` });
//     }
//     domains = [found];
//   }
//   const results = [];

//   const { results: domainStats } = await PromisePool
//     .withConcurrency(10)
//     .for(domains)
//     .process(async ({ domain }) => {
//       const domainKey = domain.replace(/\./g, 'DV');
//       const firebaseUrl = `https://king-fruit-slot.firebaseio.com/${domainKey}/PUB2/${firebaseDate}/.json`;
//       const saleReportUrl = `https://devtruestore:pas72ns2ws5ord@api-order-service.truestore.vn/api/sale-report?date=${saleReportDate}&domain=${domain}`;
//       // console.log(firebaseUrl)
//       // console.log(saleReportUrl)
//       try {
//         const [firebaseRes, saleRes] = await Promise.all([
//           axios.get(firebaseUrl, { timeout: 8000 }),
//           axios.get(saleReportUrl, { timeout: 10000 })
//         ]);

//         const firebaseData = firebaseRes.data || {};
//         const saleData = Array.isArray(saleRes.data) ? saleRes.data[0] : null;

//         let totalView = 0, totalATC = 0, totalCheckout = 0;
//         const productStats = {};

//         for (const pid in firebaseData) {
//           const item = firebaseData[pid];

//           const view = item.VC ? Object.keys(item.VC).length : 0;
//           const atc = item.ATC ? Object.keys(item.ATC).length : 0;
//           const co = item.CO5 ? Object.keys(item.CO5).length : 0;

//           totalView += view;
//           totalATC += atc;
//           totalCheckout += co;

//           productStats[pid] = {
//             product_id: pid,
//             view,
//             atc,
//             checkout: co,
//             name: item.NAME || '',
//             link: item.LK || '',
//             thumbnail: item.TB || ''
//           };
//         }

//         if (saleData && saleData.Stats) {
//           for (const pid in saleData.Stats) {
//             if (!productStats[pid]) {
//               productStats[pid] = {
//                 product_id: pid,
//                 view: 0,
//                 atc: 0,
//                 checkout: 0
//               };
//             }

//             productStats[pid].revenue = saleData.Stats[pid].revenue || 0;
//             productStats[pid].quantity = saleData.Stats[pid].quantity || 0;
//             productStats[pid].name = saleData.Stats[pid].name || productStats[pid].name || '';
//             productStats[pid].link = saleData.Stats[pid].link || productStats[pid].link || '';
//             productStats[pid].thumbnail = saleData.Stats[pid].thumbnail || productStats[pid].thumbnail || '';
//           }
//           // ✅ Nếu là GBP thì nhân revenue và money
//           if (saleData.currency === 'GBP') {
//             for (const pid in productStats) {
//               if (productStats[pid].revenue) {
//                 productStats[pid].revenue = parseFloat((productStats[pid].revenue * 1.26).toFixed(2));
//               }
//             }

//             if (saleData.money) {
//               saleData.money = parseFloat((saleData.money * 1.26).toFixed(2));
//             }
//           }
//         }




//         results.push({
//           domain,
//           date: returnDate,
//           currency: saleData?.currency,
//           orders: saleData?.orders || 0,
//           money: saleData?.money || 0,
//           orderIds: saleData?.orderIds || [],
//           total_view: totalView,
//           total_atc: totalATC,
//           total_checkout: totalCheckout,
//           products: Object.values(productStats)
//         });

//       } catch (err) {
//         console.error(`❌ Error processing domain ${domain}: ${err.message}`);
//         results.push({ domain, error: true, message: err.message });
//       }
//     });

//   res.json({
//     success: true,
//     date: returnDate,
//     data: results
//   });
// });
// //get dữ liệu ko tính trước GBP
// app.get('/api/sale-firebase-summary-notgbp', async (req, res) => {
//   const { date, domain: domainQuery } = req.query;

//   if (!date) {
//     return res.status(400).json({ success: false, message: 'Missing date (ex: 10-07-2025)' });
//   }

//   // Parse date theo định dạng DD-MM-YYYY
//   const [dayStr, monthStr, yearStr] = date.split('-');
//   const day = parseInt(dayStr, 10);
//   const month = parseInt(monthStr, 10); // tháng tính từ 1-12
//   const year = parseInt(yearStr, 10);

//   const d = new Date(year, month - 1, day);
//   if (isNaN(d.getTime())) {
//     return res.status(400).json({ success: false, message: 'Invalid date format (expected DD-MM-YYYY)' });
//   }

//   const pad = (n) => (n < 10 ? `0${n}` : n);

//   // ✅ Firebase dùng dạng D-M-YYYY (ko pad số 0)
//   const firebaseDate = `${d.getMonth() + 1}-${d.getDate()}-${d.getFullYear()}`;

//   // ✅ Sale Report dùng DD-MM-YYYY (có pad 0)
//   const saleReportDate = `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;

//   // ✅ Trả về cho client dạng YYYY-MM-DD
//   const returnDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
//   // console.log(firebaseDate)
//   // console.log(saleReportDate)
//   let domains = [];

//   try {
//     const wpResponse = await axios.get('https://truestore.us/wp-json/api/v1/getdomainaddproduct', {
//       timeout: 10000
//     });

//     if (wpResponse.data.success && Array.isArray(wpResponse.data.data)) {
//       domains = wpResponse.data.data;
//     } else {
//       return res.status(400).json({ success: false, message: 'API trả về không hợp lệ' });
//     }
//   } catch (err) {
//     return res.status(500).json({ success: false, message: 'Lỗi gọi API domain', error: err.message });
//   }

//   // Nếu có truyền domain thì chỉ xử lý domain đó
//   if (domainQuery) {
//     const found = domains.find(d => d.domain === domainQuery);
//     if (!found) {
//       return res.status(404).json({ success: false, message: `Domain '${domainQuery}' không tồn tại trong hệ thống` });
//     }
//     domains = [found];
//   }
//   const results = [];

//   const { results: domainStats } = await PromisePool
//     .withConcurrency(10)
//     .for(domains)
//     .process(async ({ domain }) => {
//       const domainKey = domain.replace(/\./g, 'DV');
//       const firebaseUrl = `https://king-fruit-slot.firebaseio.com/${domainKey}/PUB2/${firebaseDate}/.json`;
//       const saleReportUrl = `https://devtruestore:pas72ns2ws5ord@api-order-service.truestore.vn/api/sale-report?date=${saleReportDate}&domain=${domain}`;
//       // console.log(firebaseUrl)
//       // console.log(saleReportUrl)
//       try {
//         const [firebaseRes, saleRes] = await Promise.all([
//           axios.get(firebaseUrl, { timeout: 8000 }),
//           axios.get(saleReportUrl, { timeout: 10000 })
//         ]);

//         const firebaseData = firebaseRes.data || {};
//         const saleData = Array.isArray(saleRes.data) ? saleRes.data[0] : null;

//         let totalView = 0, totalATC = 0, totalCheckout = 0;
//         const productStats = {};

//         for (const pid in firebaseData) {
//           const item = firebaseData[pid];

//           const view = item.VC ? Object.keys(item.VC).length : 0;
//           const atc = item.ATC ? Object.keys(item.ATC).length : 0;
//           const co = item.CO5 ? Object.keys(item.CO5).length : 0;

//           totalView += view;
//           totalATC += atc;
//           totalCheckout += co;

//           productStats[pid] = {
//             product_id: pid,
//             view,
//             atc,
//             checkout: co,
//             name: item.NAME || '',
//             link: item.LK || '',
//             thumbnail: item.TB || ''
//           };
//         }

//         if (saleData && saleData.Stats) {
//           for (const pid in saleData.Stats) {
//             if (!productStats[pid]) {
//               productStats[pid] = {
//                 product_id: pid,
//                 view: 0,
//                 atc: 0,
//                 checkout: 0
//               };
//             }

//             productStats[pid].revenue = saleData.Stats[pid].revenue || 0;
//             productStats[pid].quantity = saleData.Stats[pid].quantity || 0;
//             productStats[pid].name = saleData.Stats[pid].name || productStats[pid].name || '';
//             productStats[pid].link = saleData.Stats[pid].link || productStats[pid].link || '';
//             productStats[pid].thumbnail = saleData.Stats[pid].thumbnail || productStats[pid].thumbnail || '';
//           }
         
//         }




//         results.push({
//           domain,
//           date: returnDate,
//           currency: saleData?.currency,
//           orders: saleData?.orders || 0,
//           money: saleData?.money || 0,
//           orderIds: saleData?.orderIds || [],
//           total_view: totalView,
//           total_atc: totalATC,
//           total_checkout: totalCheckout,
//           products: Object.values(productStats)
//         });

//       } catch (err) {
//         console.error(`❌ Error processing domain ${domain}: ${err.message}`);
//         results.push({ domain, error: true, message: err.message });
//       }
//     });

//   res.json({
//     success: true,
//     date: returnDate,
//     data: results
//   });
// });

// //get UTM tracking
// app.get('/api/sale-firebase-camp-summary', async (req, res) => {
//   const { date, domain: domainQuery } = req.query;
//   if (!date || !domainQuery) {
//     return res.status(400).json({ success: false, message: 'Missing date or domain' });
//   }

//   const [day, month, year] = date.split('-');
//   const firebaseDate = `${parseInt(month)}-${parseInt(day)}-${parseInt(year)}`;
//   const domainKey = domainQuery.replace(/\./g, 'DV');
//   const firebaseUrl = `https://king-fruit-slot.firebaseio.com/${domainKey}/PRI/${firebaseDate}/.json`;

//   try {
//     const axios = await import('axios').then(m => m.default || m);
//     const response = await axios.get(firebaseUrl, { timeout: 10000 });
//     const data = response.data;

//     const finalResult = {}; // UTM Source level

//     const processSource = (sourceKey, sourceData) => {
//       finalResult[sourceKey] = { paid: {} };

//       const campaigns = sourceData?.paid || {};
//       for (const campId in campaigns) {
//         const camp = campaigns[campId];
//         const name = camp.NAME || '';
//         const link = camp.LK || '';
//         const thumbnail = camp.TB || '';

//         const adGroups = camp.AD || {};
//         finalResult[sourceKey].paid[campId] = {};

//         for (const adId in adGroups) {
//           const creatives = adGroups[adId] || {};

//           for (const creativeId in creatives) {
//             const cr = creatives[creativeId];
//             const stats = cr.CR || {};

//             let views = stats.VC ? Object.keys(stats.VC).length : 0;
//             let atcs = stats.ATC ? Object.keys(stats.ATC).length : 0;
//             let checkouts = stats.CO ? Object.keys(stats.CO).length : 0;

//             let quantity = 0, revenue = 0;

//             if (stats.ORDER) {
//               for (const orderId in stats.ORDER) {
//                 const order = stats.ORDER[orderId];
//                 if (Array.isArray(order.line_items)) {
//                   order.line_items.forEach(item => {
//                     quantity += parseInt(item.quantity || 0);
//                     revenue += parseFloat(order.total || 0);
//                   });
//                 }
//               }
//             }

//             if (!finalResult[sourceKey].paid[campId][adId]) {
//               finalResult[sourceKey].paid[campId][adId] = {};
//             }

//             finalResult[sourceKey].paid[campId][adId][creativeId] = {
//               name,
//               link,
//               thumbnail,
//               view_content: views,
//               add_to_cart: atcs,
//               init_checkout: checkouts,
//               quantity,
//               revenue: parseFloat(revenue.toFixed(2))
//             };
//           }
//         }
//       }
//     };

//     if (data?.fb) processSource('fb', data.fb);
//     if (data?.['fb-SiteLink']) processSource('fb-SiteLink', data['fb-SiteLink']);

//     res.json({ success: true, date: `${year}-${month}-${day}`, domain: domainQuery, data: finalResult });

//   } catch (err) {
//     res.status(500).json({ success: false, message: 'Error loading Firebase', error: err.message });
//   }
// });


// Firebase base URL
const FIREBASE_BASE = 'https://king-fruit-slot.firebaseio.com';
const WP_DOMAIN_API = 'https://truestore.us/wp-json/api/v1/getdomainaddproduct';
const SALE_API_BASE = 'https://devtruestore:pas72ns2ws5ord@api-order-service.truestore.vn/api/sale-report';

// Utils
const getDateFormat = (inputDate) => {
  const [day, month, year] = inputDate.split('-').map(str => parseInt(str));
  const firebaseDate = `${month}-${day}-${year}`;
  const saleReportDate = `${day.toString().padStart(2, '0')}-${month.toString().padStart(2, '0')}-${year}`;
  const returnDate = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  return { firebaseDate, saleReportDate, returnDate };
};



// Get combined sale report and Firebase PUB2
app.get('/api/sale-firebase-summary', async (req, res) => {
  const { date, domain: domainQuery } = req.query;
  if (!date) return res.status(400).json({ success: false, message: 'Missing date (ex: 10-07-2025)' });
  const { firebaseDate, saleReportDate, returnDate } = getDateFormat(date);

  try {
    const { data: wpData } = await axios.get(WP_DOMAIN_API);
    let domains = wpData.success ? wpData.data : [];
    if (domainQuery) {
      domains = domains.filter(d => d.domain === domainQuery);
      if (!domains.length) return res.status(404).json({ success: false, message: 'Domain not found' });
    }

    const results = [];
    await PromisePool.withConcurrency(10).for(domains).process(async ({ domain }) => {
      const key = domain.replace(/\./g, 'DV');
      const firebaseUrl = `${FIREBASE_BASE}/${key}/PUB2/${firebaseDate}/.json`;
      const saleUrl = `${SALE_API_BASE}?date=${saleReportDate}&domain=${domain}`;

      try {
        const [firebaseRes, saleRes] = await Promise.all([
          axios.get(firebaseUrl, { timeout: 10000 }),
          axios.get(saleUrl, { timeout: 10000 })
        ]);

        const firebaseData = firebaseRes.data || {};
        const saleData = Array.isArray(saleRes.data) ? saleRes.data[0] : {};

        let totalView = 0, totalATC = 0, totalCheckout = 0;
        let device_mobile = 0, device_tablet = 0, device_pc = 0;

        const productStats = {};

        for (const pid in firebaseData) {
          const item = firebaseData[pid];
          // const vc = Object.keys(item.VC || {}).length;
          const vcList = item.VC || {};
          let vc = 0;
          for (const uid in vcList) {
            const deviceType = (vcList[uid] || '').toLowerCase();
            vc++;

            if (deviceType.includes('mobile')) device_mobile++;
            else if (deviceType.includes('tablet')) device_tablet++;
            else if (deviceType.includes('pc') || deviceType.includes('desktop')) device_pc++;
          }
          totalView += vc;

          const atc = Object.keys(item.ATC || {}).length;
          const co = Object.keys(item.CO5 || {}).length;
          // totalView += vc; 
          totalATC += atc; 
          totalCheckout += co;

          productStats[pid] = {
            product_id: pid,
            view: vc,
            atc: atc,
            checkout: co,
            name: item.NAME || '',
            link: item.LK || '',
            thumbnail: item.TB || ''
          };
        }

        if (saleData?.Stats) {
          for (const pid in saleData.Stats) {
            const stat = saleData.Stats[pid];
            productStats[pid] = {
              ...productStats[pid],
              revenue: stat.revenue || 0,
              quantity: stat.quantity || 0
            };
          }
        }

        if (saleData?.currency === 'GBP') {
          for (const pid in productStats) {
            if (productStats[pid].revenue)
              productStats[pid].revenue = +(productStats[pid].revenue * 1.26).toFixed(2);
          }
          if (saleData.money)
            saleData.money = +(saleData.money * 1.26).toFixed(2);
        }

        results.push({
          domain,
          date: returnDate,
          currency: saleData?.currency,
          orders: saleData?.orders || 0,
          money: saleData?.money || 0,
          orderIds: saleData?.orderIds || [],
          total_view: totalView,
          total_atc: totalATC,
          total_checkout: totalCheckout,
          device_mobile,
          device_tablet,
          device_pc,
          products: Object.values(productStats)
        });
      } catch (e) {
        results.push({ domain, error: true, message: e.message });
      }
    });

    res.json({ success: true, date: returnDate, data: results });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Get UTM / Camp-level tracking summary
app.get('/api/sale-firebase-camp-summary', async (req, res) => {
  const { date, domain: domainQuery } = req.query;
  if (!date || !domainQuery) return res.status(400).json({ success: false, message: 'Missing date or domain (ex: 10-07-2025)' });

  const { firebaseDate, saleReportDate, returnDate } = getDateFormat(date);
  const domainKey = domainQuery.replace(/\./g, 'DV');
  const firebaseUrl = `${FIREBASE_BASE}/${domainKey}/PRI/${firebaseDate}/.json`;
  const saleReportUrl = `${SALE_API_BASE}?date=${saleReportDate}&domain=${domainQuery}`;

  try {
    // const { data } = await axios.get(firebaseUrl, { timeout: 10000 });
    const [firebaseRes, saleRes] = await Promise.all([
      axios.get(firebaseUrl, { timeout: 10000 }),
      axios.get(saleReportUrl, { timeout: 10000 }),
    ]);
    const data = firebaseRes.data;
    const saleData = Array.isArray(saleRes.data) ? saleRes.data[0] : {};
    const currency = saleData?.currency;
    const multiplyRate = currency === 'GBP' ? 1.26 : 1;
    const result = {};

    const processSource = (key, payload) => {
      result[key] = { paid: {} };
      const campaigns = payload?.paid || {};

      for (const campId in campaigns) {
        const camp = campaigns[campId];
        const name = camp.NAME || '';
        const link = camp.LK || '';
        const tb = camp.TB || '';

        const adGroups = camp.AD || {};
        result[key].paid[campId] = {};

        for (const adId in adGroups) {
          const creatives = adGroups[adId] || {};
          for (const creativeId in creatives) {
            const cr = creatives[creativeId];
            const stats = cr.CR || {};
            let views = Object.keys(stats.VC || {}).length;
            let atcs = Object.keys(stats.ATC || {}).length;
            let checkouts = Object.keys(stats.CO || {}).length;
            let quantity = 0, revenue = 0;
            let orderCount = 0;
            if (stats.ORDER) {
              orderCount = Object.keys(stats.ORDER).length; // ✅ tính số đơn hàng
              for (const oid in stats.ORDER) {
                const order = stats.ORDER[oid];
                if (Array.isArray(order.line_items)) {
                  order.line_items.forEach(item => {
                    quantity += parseInt(item.quantity);
                    revenue += parseFloat(order.total || 0);
                  });
                }
              }
            }

            if (!result[key].paid[campId][adId]) result[key].paid[campId][adId] = {};
            result[key].paid[campId][adId][creativeId] = {
              name, link, thumbnail: tb,
              view_content: views,
              add_to_cart: atcs,
              init_checkout: checkouts,
              orderCount,
              // revenue: +revenue.toFixed(2)
              revenue: +(revenue * multiplyRate).toFixed(2)
            };
          }
        }
      }
    };

    // if (data?.fb) processSource('fb', data.fb);
    // if (data?.['fb-SiteLink']) processSource('fb-SiteLink', data['fb-SiteLink']);
    for (const key in data) {
      if (data[key]?.paid) {
        processSource(key, data[key]);
      }
    }


    res.json({ success: true, date: returnDate, domain: domainQuery, currency, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
