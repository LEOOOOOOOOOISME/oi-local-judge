const base = process.env.OIJ_BASE ?? 'http://127.0.0.1:8790';
const adminPassword = process.env.OIJ_ADMIN_PASSWORD;
if (!adminPassword) {
  console.error(
    'Set OIJ_ADMIN_PASSWORD (the one-time password from the server log) before running this smoke test.',
  );
  process.exit(2);
}

async function request(path, options = {}) {
  const res = await fetch(base + path, options);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, body };
}

const login = await request('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    username: process.env.OIJ_ADMIN_USERNAME ?? 'admin',
    password: adminPassword,
  }),
});
if (login.status !== 200) {
  console.error('login failed', login.status, login.body);
  process.exit(1);
}
const cookie = String(login.headers.get('set-cookie') ?? '').split(';')[0];
const auth = { cookie };

const me = await request('/api/me', { headers: auth });
const problems = await request('/api/problems', { headers: auth });
const problemId = problems.body?.data?.[0]?.id;
const submit = await request('/api/submissions', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({
    problemId,
    language: 'cpp17',
    code: '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}',
  }),
});
const submissionId = submit.body?.data?.id;
let detail = null;
for (let i = 0; i < 30; i++) {
  detail = submissionId
    ? await request(`/api/submissions/${submissionId}`, { headers: auth })
    : null;
  const status = detail?.body?.data?.status;
  if (status === 'finished' || status === 'failed') break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const ranking = await request('/api/contests/1/ranking', { headers: auth });

console.log(
  JSON.stringify(
    {
      login: login.status,
      me: me.body?.data?.user?.username,
      problems: problems.body?.data?.length,
      submit: submit.status,
      submissionId,
      detailStatus: detail?.body?.data?.status,
      verdict: detail?.body?.data?.verdict,
      score: detail?.body?.data?.score,
      tests: detail?.body?.data?.results?.length,
      rankingRows: ranking.body?.data?.length,
    },
    null,
    2,
  ),
);
