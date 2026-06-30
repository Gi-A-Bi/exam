// 테스트용 supabase service_role 클라이언트 더블.
// 실제 네트워크/Supabase 없이 핸들러 로직만 검증하기 위한 최소 구현.
// supabase-js 의 쿼리 빌더 체인(.from().select().eq().maybeSingle(), .insert())과
// admin.auth.admin.createUser/deleteUser 를 흉내 낸다.

export interface MockDb {
  settings: Array<{ key: string; value: string }>;
  teachers: Array<{ id: string; code: string; name: string }>;
  answer_keys: Array<any>;
  submissions: Array<any>;     // insert 결과가 쌓임
  authUsers: Array<{ id: string; email: string }>;  // createUser 결과가 쌓임
  insertError?: Record<string, { message: string }>; // 특정 테이블 insert 강제 실패
}

let __id = 0;
const nextId = () => "user-" + (++__id);

export function makeAdmin(db: MockDb) {
  const match = (rows: any[], filters: Record<string, unknown>) =>
    rows.filter((r) => Object.keys(filters).every((k) => r[k] === filters[k]));

  function from(table: string) {
    const filters: Record<string, unknown> = {};
    const builder: any = {
      select() { return builder; },
      eq(k: string, v: unknown) { filters[k] = v; return builder; },
      maybeSingle() {
        const rows = match((db as any)[table] ?? [], filters);
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      insert(payload: any) {
        if (db.insertError && db.insertError[table]) {
          return Promise.resolve({ data: null, error: db.insertError[table] });
        }
        (db as any)[table].push(payload);
        return Promise.resolve({ data: payload, error: null });
      },
    };
    return builder;
  }

  const auth = {
    admin: {
      createUser({ email }: { email: string; password: string; email_confirm: boolean }) {
        if (db.authUsers.some((u) => u.email === email)) {
          return Promise.resolve({
            data: null,
            error: { message: "A user with this email address has already been registered" },
          });
        }
        const user = { id: nextId(), email };
        db.authUsers.push(user);
        return Promise.resolve({ data: { user }, error: null });
      },
      deleteUser(id: string) {
        db.authUsers = db.authUsers.filter((u) => u.id !== id);
        return Promise.resolve({ data: null, error: null });
      },
    },
  };

  return { from, auth };
}
