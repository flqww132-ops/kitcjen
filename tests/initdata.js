// Подписанный initData для тестов (как это делает Telegram)
const crypto = require('crypto');
module.exports = function make(token, userId = 777, authDate = Math.floor(Date.now() / 1000)) {
  const fields = { auth_date: String(authDate), query_id: 'AAH_test', user: JSON.stringify({ id: userId, first_name: 'Шеф' }), signature: 'xyz' };
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
};
