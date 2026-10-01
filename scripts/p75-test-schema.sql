-- 운영 migration이 아니다. identity와 lease/fencing 실험은 격리 disposable D1에서만 실행한다.
CREATE TABLE p75_environment(name TEXT PRIMARY KEY,id TEXT NOT NULL);
INSERT INTO p75_environment VALUES('us-stock-dashboard-p75-rehearsal-20261001','de3f265c-d6ec-4561-8a53-64effad66eb5');
CREATE TABLE p75_leases(lock_key TEXT PRIMARY KEY,dataset TEXT NOT NULL,owner TEXT NOT NULL,fence INTEGER NOT NULL,expires_ms INTEGER NOT NULL);
CREATE TABLE p75_guard(id INTEGER PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO p75_guard VALUES(1,1);
