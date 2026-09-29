const express=require("express");
const http=require("http");
const {Server}=require("socket.io");
const path=require("path");
const crypto=require("crypto");

const app=express();
const server=http.createServer(app);
const io=new Server(server,{maxHttpBufferSize:15*1024*1024});

app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.get("/manifest.json",(req,res)=>res.sendFile(path.join(__dirname,"manifest.json")));
app.get("/sw.js",(req,res)=>res.sendFile(path.join(__dirname,"sw.js")));
app.use(express.static(path.join(__dirname,"public")));

const rooms=new Map(); // roomCode -> {users:Set, messages:[]}

function code(){
  let c;
  do { c=crypto.randomBytes(3).toString("hex").toUpperCase(); } while(rooms.has(c));
  return c;
}

io.on("connection",socket=>{
  socket.on("create_room",()=>{
    const room=code();
    rooms.set(room,{users:new Set([socket.id]),messages:[]});
    socket.join(room); socket.data.room=room;
    socket.emit("room_created",{room});
  });

  socket.on("join_room",room=>{
    room=String(room||"").trim().toUpperCase();
    const r=rooms.get(room);
    if(!r){socket.emit("error_message","Invalid or expired pairing code.");return;}
    if(r.users.size>=2 && !r.users.has(socket.id)){
      socket.emit("error_message","This chat already has two people.");return;
    }
    r.users.add(socket.id); socket.join(room); socket.data.room=room;
    socket.emit("joined",{room,messages:r.messages});
    socket.to(room).emit("partner_status",{online:true});
  });

  socket.on("set_name",name=>{
    const room=socket.data.room,r=rooms.get(room);
    if(!r || !r.users.has(socket.id)) return;
    socket.data.name=String(name||"").trim().slice(0,30) || "Guest";
    io.to(room).emit("name_changed",{id:socket.id,name:socket.data.name});
  });

  socket.on("typing",isTyping=>{
    const room=socket.data.room,r=rooms.get(room);
    if(!r || !r.users.has(socket.id)) return;
    socket.to(room).emit("typing",{name:socket.data.name||"Partner",isTyping:!!isTyping});
  });

  socket.on("message",m=>{
    const room=socket.data.room,r=rooms.get(room);
    if(!r || !r.users.has(socket.id)) return;
    const allowed=["text","photo","audio"];
    const type=allowed.includes(m?.type)?m.type:"text";
    const data=m?.data;
    if(typeof data!=="string" || data.length>15*1024*1024) return;

    const msg={
      id:crypto.randomUUID(),
      sender:socket.id,
      name:socket.data.name||"Guest",
      type,data,time:Date.now(),deleted:false,
      seenBy:[socket.id]
    };
    r.messages.push(msg);
    io.to(room).emit("message",msg);
  });

  socket.on("mark_seen",id=>{
    const room=socket.data.room,r=rooms.get(room);
    if(!r || !r.users.has(socket.id)) return;
    const m=r.messages.find(x=>x.id===id);
    if(!m) return;
    if(!m.seenBy.includes(socket.id)) m.seenBy.push(socket.id);
    io.to(room).emit("message_seen",{id,seenBy:m.seenBy});
  });

  socket.on("delete_for_both",id=>{
    const room=socket.data.room,r=rooms.get(room); if(!r)return;
    const m=r.messages.find(x=>x.id===id); if(!m)return;
    if(m.sender!==socket.id)return;
    m.deleted=true; delete m.data;
    io.to(room).emit("message_deleted",{id});
  });

  socket.on("disconnect",()=>{
    const room=socket.data.room,r=rooms.get(room); if(!r)return;
    r.users.delete(socket.id);
    socket.to(room).emit("partner_status",{online:false});
    if(r.users.size===0) rooms.delete(room);
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,"0.0.0.0",()=>console.log(`Sngi Chat running on port ${PORT}`));
