Option Explicit
Dim v, s, outPath, textPath, fso, ts
outPath = WScript.Arguments(0)
textPath = WScript.Arguments(1)

' 以 UTF-8 读入播报文本（避免 VBS 源文件编码问题）
Dim st
Set st = CreateObject("ADODB.Stream")
st.Type = 2
st.Charset = "utf-8"
st.Open
st.LoadFromFile textPath
Dim txt
txt = st.ReadText(-1)
st.Close

Set v = CreateObject("SAPI.SpVoice")
Set s = CreateObject("SAPI.SpFileStream")
s.Format.Type = 22
s.Open outPath, 3, False
Set v.AudioOutputStream = s
v.Speak txt
s.Close
WScript.Echo "OK"
