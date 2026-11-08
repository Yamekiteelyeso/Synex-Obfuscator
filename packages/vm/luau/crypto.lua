-- Synex runtime cryptography primitives.
-- Pure Luau; requires the standard bit32 library.
-- Construction: XChaCha20 stream encryption + HMAC-SHA256 (Encrypt-then-MAC).
-- This is deliberately NOT labelled XChaCha20-Poly1305.
local bit = bit32
assert(bit, "bit32 is required")
local band, bxor = bit.band, bit.bxor
local rshift, rrotate = bit.rshift, bit.rrotate
local MOD = 4294967296
local function u32(x) return x % MOD end
local function add(a, b, c, d, e)
	return u32((a or 0) + (b or 0) + (c or 0) + (d or 0) + (e or 0))
end
local function read32le(s, i)
	local a,b,c,d = string.byte(s, i, i + 3)
	assert(d, "truncated 32-bit word")
	return a + b*256 + c*65536 + d*16777216
end
local function write32le(x)
	x = u32(x)
	return string.char(x%256, math.floor(x/256)%256, math.floor(x/65536)%256, math.floor(x/16777216)%256)
end
local function read32be(s, i)
	local a,b,c,d = string.byte(s, i, i + 3)
	assert(d, "truncated 32-bit word")
	return a*16777216 + b*65536 + c*256 + d
end
local function write32be(x)
	x = u32(x)
	return string.char(math.floor(x/16777216)%256, math.floor(x/65536)%256, math.floor(x/256)%256, x%256)
end
local function wordsLE(s)
	assert(#s % 4 == 0, "word input must be aligned")
	local out = {}
	for i=1,#s,4 do out[#out+1] = read32le(s,i) end
	return out
end

-- SHA-256
local K = {
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
}
local function sha256(message)
	assert(type(message) == "string", "message must be a string")
	local bitLength = #message * 8
	local pad = message .. string.char(128)
	pad = pad .. string.rep("\0", (56 - (#pad % 64)) % 64)
	pad = pad .. write32be(math.floor(bitLength / MOD)) .. write32be(bitLength % MOD)
	local h = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19}
	for offset=1,#pad,64 do
		local w = {}
		for i=0,15 do w[i+1] = read32be(pad,offset+i*4) end
		for i=17,64 do
			local x,y = w[i-15],w[i-2]
			local s0 = bxor(rrotate(x,7),rrotate(x,18),rshift(x,3))
			local s1 = bxor(rrotate(y,17),rrotate(y,19),rshift(y,10))
			w[i] = add(w[i-16],s0,w[i-7],s1)
		end
		local a,b,c,d,e,f,g,hh = table.unpack(h)
		for i=1,64 do
			local S1 = bxor(rrotate(e,6),rrotate(e,11),rrotate(e,25))
			local ch = bxor(band(e,f),band(bit.bnot(e),g))
			local t1 = add(hh,S1,ch,K[i],w[i])
			local S0 = bxor(rrotate(a,2),rrotate(a,13),rrotate(a,22))
			local maj = bxor(band(a,b),band(a,c),band(b,c))
			local t2 = add(S0,maj)
			hh,g,f,e,d,c,b,a = g,f,e,add(d,t1),c,b,a,add(t1,t2)
		end
		h[1]=add(h[1],a); h[2]=add(h[2],b); h[3]=add(h[3],c); h[4]=add(h[4],d)
		h[5]=add(h[5],e); h[6]=add(h[6],f); h[7]=add(h[7],g); h[8]=add(h[8],hh)
	end
	local out = {}
	for i=1,8 do out[i] = write32be(h[i]) end
	return table.concat(out)
end
local function hmacSha256(key,message)
	assert(type(key)=="string" and type(message)=="string","key and message must be strings")
	if #key > 64 then key = sha256(key) end
	key = key .. string.rep("\0",64-#key)
	local inner,outer = {},{}
	for i=1,64 do
		local v = string.byte(key,i)
		inner[i] = string.char(bxor(v,0x36))
		outer[i] = string.char(bxor(v,0x5c))
	end
	return sha256(table.concat(outer)..sha256(table.concat(inner)..message))
end

-- ChaCha20 / HChaCha20
local SIGMA = {0x61707865,0x3320646e,0x79622d32,0x6b206574}
local function quarter(x,a,b,c,d)
	x[a]=add(x[a],x[b]); x[d]=rrotate(bxor(x[d],x[a]),16)
	x[c]=add(x[c],x[d]); x[b]=rrotate(bxor(x[b],x[c]),20)
	x[a]=add(x[a],x[b]); x[d]=rrotate(bxor(x[d],x[a]),24)
	x[c]=add(x[c],x[d]); x[b]=rrotate(bxor(x[b],x[c]),25)
end
local function rounds(state)
	local x = {table.unpack(state)}
	for _=1,10 do
		quarter(x,1,5,9,13); quarter(x,2,6,10,14); quarter(x,3,7,11,15); quarter(x,4,8,12,16)
		quarter(x,1,6,11,16); quarter(x,2,7,12,13); quarter(x,3,8,9,14); quarter(x,4,5,10,15)
	end
	return x
end
local function initial(key,nonce,counter)
	assert(#key==32 and #nonce==12,"invalid ChaCha20 key or nonce")
	local kw,nw = wordsLE(key),wordsLE(nonce)
	local s = {SIGMA[1],SIGMA[2],SIGMA[3],SIGMA[4]}
	for i=1,8 do s[#s+1]=kw[i] end
	s[#s+1]=counter
	for i=1,3 do s[#s+1]=nw[i] end
	return s
end
local function chachaBlock(key,nonce,counter)
	local s=initial(key,nonce,counter)
	local x=rounds(s)
	local out={}
	for i=1,16 do out[i]=write32le(add(x[i],s[i])) end
	return table.concat(out)
end
local function hchacha20(key,nonce16)
	assert(#key==32 and #nonce16==16,"invalid HChaCha20 input")
	local kw,nw=wordsLE(key),wordsLE(nonce16)
	local s={SIGMA[1],SIGMA[2],SIGMA[3],SIGMA[4]}
	for i=1,8 do s[#s+1]=kw[i] end
	for i=1,4 do s[#s+1]=nw[i] end
	local x=rounds(s)
	return write32le(x[1])..write32le(x[2])..write32le(x[3])..write32le(x[4])
		..write32le(x[13])..write32le(x[14])..write32le(x[15])..write32le(x[16])
end
local function xorBytes(a,b)
	assert(#a==#b,"xor inputs must have equal length")
	local out={}
	for i=1,#a do out[i]=string.char(bxor(string.byte(a,i),string.byte(b,i))) end
	return table.concat(out)
end
local function xchachaXor(key,nonce24,input,initialCounter)
	assert(#key==32 and #nonce24==24,"XChaCha20 requires a 32-byte key and 24-byte nonce")
	local subkey=hchacha20(key,string.sub(nonce24,1,16))
	local nonce12="\0\0\0\0"..string.sub(nonce24,17,24)
	local out,counter={},initialCounter or 1
	for offset=1,#input,64 do
		assert(counter<MOD,"ChaCha20 counter exhausted")
		local block=chachaBlock(subkey,nonce12,counter)
		local chunk=string.sub(input,offset,offset+63)
		out[#out+1]=xorBytes(chunk,string.sub(block,1,#chunk))
		counter=counter+1
	end
	return table.concat(out)
end
local function le64(n)
	local lo=n%MOD
	local hi=math.floor(n/MOD)
	return write32le(lo)..write32le(hi)
end
local function constantTimeEqual(a,b)
	if type(a)~="string" or type(b)~="string" or #a~=#b then return false end
	local diff=0
	for i=1,#a do diff=bit.bor(diff,bxor(string.byte(a,i),string.byte(b,i))) end
	return diff==0
end


-- Poly1305 using ten 13-bit limbs. Products remain below the exact-integer
-- range of IEEE-754 doubles used by Luau; no floating-point approximation is used.
local POLY_BASE = 8192
local function polyLimbs(bytes, count)
	local out = {}
	for limb=0,count-1 do
		local value = 0
		for j=0,12 do
			local bitIndex = limb*13+j
			local byteIndex = math.floor(bitIndex/8)+1
			if byteIndex <= #bytes then
				local byte = string.byte(bytes,byteIndex)
				local bitValue = math.floor(byte / (2^(bitIndex%8))) % 2
				value = value + bitValue*(2^j)
			end
		end
		out[limb+1] = value
	end
	return out
end
local function polyBytes(limbs, length)
	local out = {}
	for byteIndex=0,length-1 do
		local value = 0
		for j=0,7 do
			local bitIndex = byteIndex*8+j
			local limbIndex = math.floor(bitIndex/13)+1
			local limbBit = bitIndex%13
			local bitValue = math.floor(limbs[limbIndex]/(2^limbBit))%2
			value = value + bitValue*(2^j)
		end
		out[#out+1] = string.char(value)
	end
	return table.concat(out)
end
local function poly1305(message, oneTimeKey)
	assert(type(message)=="string" and type(oneTimeKey)=="string" and #oneTimeKey==32,
		"Poly1305 requires a message and a 32-byte one-time key")
	local rBytes = {string.byte(string.sub(oneTimeKey,1,16),1,16)}
	rBytes[4] = band(rBytes[4],15); rBytes[8] = band(rBytes[8],15)
	rBytes[12] = band(rBytes[12],15); rBytes[16] = band(rBytes[16],15)
	rBytes[5] = band(rBytes[5],252); rBytes[9] = band(rBytes[9],252)
	rBytes[13] = band(rBytes[13],252)
	local clamped = {}
	for i=1,16 do clamped[i]=string.char(rBytes[i]) end
	local r = polyLimbs(table.concat(clamped),10)
	local s = polyLimbs(string.sub(oneTimeKey,17,32),10)
	local h = {0,0,0,0,0,0,0,0,0,0}
	for offset=1,#message,16 do
		local block = string.sub(message,offset,offset+15)
		local m = polyLimbs(block.."\1",10)
		for i=1,10 do h[i]=h[i]+m[i] end
		local d = {0,0,0,0,0,0,0,0,0,0}
		for i=0,9 do
			for j=0,9 do
				local k=i+j
				local product=h[i+1]*r[j+1]
				if k>=10 then d[k-9]=d[k-9]+product*5
				else d[k+1]=d[k+1]+product end
			end
		end
		for pass=1,3 do
			for i=1,10 do
				local carry=math.floor(d[i]/POLY_BASE)
				d[i]=d[i]-carry*POLY_BASE
				if i<10 then d[i+1]=d[i+1]+carry
				else d[1]=d[1]+carry*5 end
			end
		end
		h=d
	end
	-- Canonical reduction modulo 2^130-5.
	local reduced, borrow = {}, 0
	for i=1,10 do
		local modulusLimb = i==1 and 8187 or 8191
		local value=h[i]-modulusLimb-borrow
		if value<0 then value=value+POLY_BASE; borrow=1 else borrow=0 end
		reduced[i]=value
	end
	if borrow==0 then h=reduced end
	-- Add s modulo 2^128 (the upper two bits of limb ten are discarded).
	local tagLimbs, carry = {}, 0
	for i=1,10 do
		local value=h[i]+s[i]+carry
		if i==10 then tagLimbs[i]=value%2048
		else tagLimbs[i]=value%POLY_BASE; carry=math.floor(value/POLY_BASE) end
	end
	return polyBytes(tagLimbs,16)
end
local function xchachaContext(key,nonce24)
	assert(type(key)=="string" and #key==32 and type(nonce24)=="string" and #nonce24==24,
		"XChaCha20-Poly1305 requires a 32-byte key and 24-byte nonce")
	local subkey=hchacha20(key,string.sub(nonce24,1,16))
	local nonce12="\0\0\0\0"..string.sub(nonce24,17,24)
	local firstBlock=chachaBlock(subkey,nonce12,0)
	return subkey,nonce12,string.sub(firstBlock,1,32)
end
local function pad16(value)
	local remainder=#value%16
	return remainder==0 and "" or string.rep("\0",16-remainder)
end
local function sealPoly1305(key,nonce24,plaintext,aad)
	aad=aad or ""
	assert(type(plaintext)=="string" and type(aad)=="string","plaintext and AAD must be strings")
	local subkey,nonce12,polyKey=xchachaContext(key,nonce24)
	local ciphertext=xchachaXor(key,nonce24,plaintext,1)
	local macData=aad..pad16(aad)..ciphertext..pad16(ciphertext)..le64(#aad)..le64(#ciphertext)
	return ciphertext,poly1305(macData,polyKey)
end
local function openPoly1305(key,nonce24,ciphertext,tag,aad)
	aad=aad or ""
	if type(ciphertext)~="string" or type(tag)~="string" or #tag~=16 or type(aad)~="string" then
		return nil,"authentication failed"
	end
	local _,_,polyKey=xchachaContext(key,nonce24)
	local macData=aad..pad16(aad)..ciphertext..pad16(ciphertext)..le64(#aad)..le64(#ciphertext)
	local expected=poly1305(macData,polyKey)
	if not constantTimeEqual(expected,tag) then return nil,"authentication failed" end
	return xchachaXor(key,nonce24,ciphertext,1)
end

-- Encrypt-then-MAC; nonce uniqueness per key is mandatory.
local function seal(key,nonce24,plaintext,aad)
	assert(type(key)=="string" and #key==32,"key must be 32 bytes")
	assert(type(nonce24)=="string" and #nonce24==24,"nonce must be 24 bytes")
	assert(type(plaintext)=="string","plaintext must be a string")
	aad=aad or ""
	assert(type(aad)=="string","AAD must be a string")
	local ciphertext=xchachaXor(key,nonce24,plaintext,1)
	local macKey=hmacSha256(key,"Synex/XChaCha20-HMAC-SHA256/mac-key\0"..nonce24)
	local tag=hmacSha256(macKey,le64(#aad)..aad..le64(#ciphertext)..ciphertext)
	return ciphertext,tag
end
local function open(key,nonce24,ciphertext,tag,aad)
	assert(type(key)=="string" and #key==32,"key must be 32 bytes")
	assert(type(nonce24)=="string" and #nonce24==24,"nonce must be 24 bytes")
	assert(type(ciphertext)=="string" and type(tag)=="string","ciphertext and tag must be strings")
	aad=aad or ""
	local macKey=hmacSha256(key,"Synex/XChaCha20-HMAC-SHA256/mac-key\0"..nonce24)
	local expected=hmacSha256(macKey,le64(#aad)..aad..le64(#ciphertext)..ciphertext)
	if not constantTimeEqual(expected,tag) then return nil,"authentication failed" end
	return xchachaXor(key,nonce24,ciphertext,1)
end
return {
	sha256=sha256,hmacSha256=hmacSha256,hchacha20=hchacha20,chachaBlock=chachaBlock,
	xchachaXor=xchachaXor,poly1305=poly1305,sealPoly1305=sealPoly1305,
	openPoly1305=openPoly1305,seal=seal,open=open,constantTimeEqual=constantTimeEqual,
}
