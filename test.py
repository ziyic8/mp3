import requests, json, time

BASE = "http://localhost:3000"
HEADERS_JSON = {"Content-Type": "application/json"}
HEADERS_FORM = {"Content-Type": "application/x-www-form-urlencoded"}

def p(resp):
    try:
        print(json.dumps(resp.json(), indent=2))
    except:
        print(resp.text)

def check(status, expected, name):
    if status == expected:
        print(f"✅ {name} passed ({status})")
    else:
        print(f"❌ {name} failed (got {status}, expected {expected})")

# ---------------------------------------------------------------------
# 0. 健康测试
# ---------------------------------------------------------------------
print("\n=== 0. 健康检查 ===")
r = requests.get(BASE + "/api/users")
check(r.status_code, 200, "GET /api/users")
r = requests.get(BASE + "/api/tasks")
check(r.status_code, 200, "GET /api/tasks")

# ---------------------------------------------------------------------
# 1. GET 查询参数基本功能
# ---------------------------------------------------------------------
print("\n=== 1. GET 查询参数 ===")
r = requests.get(BASE + '/api/users?where={"email":{"$regex":".com"}}&limit=2')
check(r.status_code, 200, "GET /users with where+limit")

r = requests.get(BASE + '/api/tasks?count=true')
check(r.status_code, 200, "GET /tasks count")

r = requests.get(BASE + '/api/users?sort={"name":1}&select={"name":1,"email":1}')
check(r.status_code, 200, "GET /users sort+select")

r = requests.get(BASE + '/api/tasks?filter={"_id":1}')  # 测试 filter 别名
check(r.status_code, 200, "GET /tasks filter alias")

# ---------------------------------------------------------------------
# 2. POST 创建用户与任务
# ---------------------------------------------------------------------
print("\n=== 2. POST ===")
user_data = {"name": "Alice", "email": "alice@example.com"}
r = requests.post(BASE + "/api/users", headers=HEADERS_JSON, data=json.dumps(user_data))
check(r.status_code, 201, "POST /users")
u = r.json()["data"]["_id"]

task_data = {
    "name": "Task1",
    "deadline": "2030-01-01T00:00:00.000Z",
    "description": "testing task",
    "completed": False
}
r = requests.post(BASE + "/api/tasks", headers=HEADERS_JSON, data=json.dumps(task_data))
check(r.status_code, 201, "POST /tasks")
t = r.json()["data"]["_id"]

# ---------------------------------------------------------------------
# 3. GET /:id 测试 + 错误分支
# ---------------------------------------------------------------------
print("\n=== 3. GET /:id ===")
r = requests.get(f"{BASE}/api/users/{u}?select={{\"name\":1}}")
check(r.status_code, 200, "GET /users/:id select")

r = requests.get(f"{BASE}/api/users/abc")  # 非法 ObjectId
check(r.status_code, 404, "GET /users bad id")

r = requests.get(f"{BASE}/api/tasks/{t}?select={{\"name\":1}}")
check(r.status_code, 200, "GET /tasks/:id select")

# ---------------------------------------------------------------------
# 4. PUT 同步逻辑 (tasks -> users)
# ---------------------------------------------------------------------
print("\n=== 4. PUT 同步 (task -> user) ===")
task_update = {
    "name": "Task1",
    "deadline": "2030-01-01T00:00:00.000Z",
    "completed": False,
    "assignedUser": u,
    "assignedUserName": "Alice"
}
r = requests.put(f"{BASE}/api/tasks/{t}", headers=HEADERS_JSON, data=json.dumps(task_update))
check(r.status_code, 200, "PUT /tasks assign user")

# 校验用户 pendingTasks 中包含此任务
r = requests.get(f"{BASE}/api/users/{u}")
if t in json.dumps(r.json()):
    print("✅ pendingTasks contains task after assign")
else:
    print("❌ pendingTasks not updated after assign")

# 完成任务 -> 用户 pendingTasks 应移除
task_update["completed"] = True
r = requests.put(f"{BASE}/api/tasks/{t}", headers=HEADERS_JSON, data=json.dumps(task_update))
check(r.status_code, 200, "PUT /tasks mark complete")

r = requests.get(f"{BASE}/api/users/{u}")
if t not in json.dumps(r.json()):
    print("✅ pendingTasks cleared after complete")
else:
    print("❌ pendingTasks still present after complete")

# ---------------------------------------------------------------------
# 5. PUT 同步逻辑 (users -> tasks)
# ---------------------------------------------------------------------
print("\n=== 5. PUT 同步 (user -> tasks) ===")
# 新建两个任务
def create_task(name):
    data = {
        "name": name,
        "deadline": "2030-01-01T00:00:00.000Z",
        "description": "sync test"
    }
    r = requests.post(BASE + "/api/tasks", headers=HEADERS_JSON, data=json.dumps(data))
    return r.json()["data"]["_id"]

t1 = create_task("Tsync1")
t2 = create_task("Tsync2")

# 更新用户 pendingTasks = [t1, t2]
update_user = {
    "name": "Alice",
    "email": "alice@example.com",
    "pendingTasks": [t1, t2]
}
r = requests.put(f"{BASE}/api/users/{u}", headers=HEADERS_JSON, data=json.dumps(update_user))
check(r.status_code, 200, "PUT /users assign tasks")

# 校验任务被指派
r1 = requests.get(f"{BASE}/api/tasks/{t1}")
r2 = requests.get(f"{BASE}/api/tasks/{t2}")
assert r1.json()["data"]["assignedUser"] == u
assert r2.json()["data"]["assignedUser"] == u
print("✅ tasks assigned correctly to user via PUT /users")

# ---------------------------------------------------------------------
# 6. DELETE 用户与任务
# ---------------------------------------------------------------------
print("\n=== 6. DELETE ===")
r = requests.delete(f"{BASE}/api/tasks/{t}")
check(r.status_code, 204, "DELETE /tasks/:id")

r = requests.delete(f"{BASE}/api/users/{u}")
check(r.status_code, 204, "DELETE /users/:id")

# ---------------------------------------------------------------------
# 7. 错误响应格式统一性检查
# ---------------------------------------------------------------------
print("\n=== 7. 错误格式 ===")
r = requests.post(BASE + "/api/users", headers=HEADERS_JSON, data='{"name": ""}')
check(r.status_code, 400, "POST /users missing fields")
try:
    msg = r.json()["message"]
    print("✅ message field present:", msg)
except:
    print("❌ no message field in error response")

# ---------------------------------------------------------------------
# 8. 默认 limit=100 (tasks)
# ---------------------------------------------------------------------
print("\n=== 8. 默认 limit 测试 ===")
r = requests.get(BASE + "/api/tasks")
d = r.json()["data"]
if len(d) <= 100:
    print("✅ default limit<=100")
else:
    print("❌ default limit incorrect")

print("\n🎯 测试结束！请检查上面输出。")
