#!/usr/bin/env bash
# 端到端联调脚本：真实后端 + 真实 MongoDB/Redis/Milvus + 真实大模型 API
# 覆盖：注册 -> 登录 -> 普通流式对话 -> 会话列表 -> 历史记录
#       -> 知识库上传(解析/切片/向量化) -> 知识库问答 -> 知识库文件列表 -> 删除
set -u
export PATH="/c/Users/97689/AppData/Local/Programs/kimi-desktop/resources/resources/runtime:$PATH"
BASE="http://127.0.0.1:3000"
ROOT="/c/Users/97689/Desktop/AI_Coder"
WORK="$ROOT/nest-serve/test/e2e-assets"
# Windows 原生 curl 不认识 MSYS 风格路径，-F 文件参数需要用 Windows 路径
WORK_WIN='C:\Users\97689\Desktop\AI_Coder\nest-serve\test\e2e-assets'
mkdir -p "$WORK"

cd "$ROOT/nest-serve"
node dist/src/main.js > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null; }
trap cleanup EXIT

# 等待服务起来
echo "== 等待后端启动 =="
for i in $(seq 1 30); do
  if curl -s -o /dev/null --max-time 2 -X POST "$BASE/userinfo/loginuser"; then echo "后端已启动"; break; fi
  sleep 1
done

PHONE="139$(date +%s | tail -c 9)"
PASS="Test1234"
echo "== 1. 注册 ($PHONE) =="
REGISTER=$(curl -s -X POST "$BASE/userinfo/registeruser" -H 'Content-Type: application/json' \
  -d "{\"phoneNumber\":\"$PHONE\",\"password\":\"$PASS\",\"confirmPassWord\":\"$PASS\"}")
echo "$REGISTER" | head -c 300; echo
TOKEN=$(node -e "const r=JSON.parse(process.argv[1]); if(!r.data||!r.data.token){console.error('注册失败');process.exit(1)} console.log(r.data.token)" "$REGISTER")

echo "== 2. 登录 =="
LOGIN=$(curl -s -X POST "$BASE/userinfo/loginuser" -H 'Content-Type: application/json' \
  -d "{\"phoneNumber\":\"$PHONE\",\"password\":\"$PASS\"}")
echo "$LOGIN" | head -c 200; echo

echo "== 3. 普通流式对话（新会话） =="
# 注意：Windows curl 会把命令行里的中文参数转成 GBK，JSON 请求体先落盘成 UTF-8 文件再发送
node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({content:'你好，请用一句话介绍你自己',sessionId:'null',isKnowledgeBased:false}))" "$WORK/payload1.json"
curl -s -N --max-time 120 -X POST "$BASE/chat/sendmessage" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json; charset=utf-8' \
  --data-binary "@$WORK/payload1.json" \
  > "$WORK/chat1.stream"
head -c 600 "$WORK/chat1.stream"; echo
SESSION_ID=$(node -e "
const fs=require('fs');
const parts=fs.readFileSync(process.argv[1],'utf8').split('###ABC###').filter(s=>s.trim());
for(const p of parts){ try{ const o=JSON.parse(p); if(o.type==='sessionId'){ console.log(o.sessionId); process.exit(0);} }catch(e){} }
process.exit(1);
" "$WORK/chat1.stream")
echo "SESSION_ID=$SESSION_ID"

echo "== 4. 会话列表 =="
curl -s "$BASE/chat/sessionlist" -H "Authorization: Bearer $TOKEN" | head -c 400; echo

echo "== 5. 历史记录 =="
curl -s "$BASE/chat/history?sessionId=$SESSION_ID" -H "Authorization: Bearer $TOKEN" | head -c 500; echo

echo "== 6. 构造测试文档并上传知识库 =="
python - <<'PYEOF'
from docx import Document
doc = Document()
doc.add_heading('检索增强生成（RAG）技术综述', 0)
doc.add_paragraph('检索增强生成（Retrieval-Augmented Generation，RAG）是一种将外部知识检索与大语言模型生成相结合的技术框架。其核心流程包括：文档解析与切片、向量化入库、查询时检索相关片段、将片段注入上下文让模型生成回答。')
doc.add_paragraph('混合检索是提升 RAG 召回率的关键手段，通常将稠密向量检索（语义相似）与稀疏关键词检索（如 BM25 或 LIKE 匹配）相结合，并采用倒数排名融合（RRF）对两路结果进行融合排序，兼顾语义相关性与精确关键词命中。')
doc.add_paragraph('RAG 的常用评估指标包括：检索阶段的召回率（Recall@k）、命中率（Hit Rate），以及生成阶段的忠实度（Faithfulness）与答案相关性（Answer Relevancy）。常用评估框架有 RAGAS、TruLens 等。')
doc.add_paragraph('工程实践中，RAG 还需要处理切片粒度选择、查询改写、多轮对话中的指代消解、以及向量数据库（如 Milvus、FAISS）的索引构建与维护等问题。')
doc.save(r'C:\Users\97689\Desktop\AI_Coder\nest-serve\test\e2e-assets\rag-survey.docx')
print('docx 已生成')
PYEOF

UPLOAD=$(curl -s --max-time 180 -X POST "$BASE/fileanagement/knowledge" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@$WORK_WIN\\rag-survey.docx;type=application/vnd.openxmlformats-officedocument.wordprocessingml.document")
echo "$UPLOAD" | head -c 400; echo
KB_FILE_ID=$(node -e "const r=JSON.parse(process.argv[1]); const f=r.data&&r.data.files&&r.data.files[0]; if(!f){console.error('上传失败');process.exit(1)} console.log(f.id)" "$UPLOAD")

echo "== 7. 知识库问答（流式） =="
node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({content:'RAG 有哪些常用评估指标？',sessionId:process.argv[2],isKnowledgeBased:true}))" "$WORK/payload2.json" "$SESSION_ID"
curl -s -N --max-time 180 -X POST "$BASE/chat/sendmessage" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json; charset=utf-8' \
  --data-binary "@$WORK/payload2.json" \
  > "$WORK/chat2.stream"
head -c 800 "$WORK/chat2.stream"; echo

echo "== 8. 知识库文件列表 =="
curl -s "$BASE/fileanagement/kbfilelist" -H "Authorization: Bearer $TOKEN" | head -c 300; echo

echo "== 9. 删除知识库文件 =="
curl -s -X DELETE "$BASE/fileanagement/knowledge/$KB_FILE_ID" -H "Authorization: Bearer $TOKEN" | head -c 200; echo

echo "== 全部步骤执行完毕 =="
