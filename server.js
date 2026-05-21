const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL_NAME = "gemini-2.5-flash"; 

app.post('/webhook', async (req, res) => {
    // 1. Phản hồi lập tức HTTP 200 OK để giải phóng UI của AppSheet, tránh bẫy Timeout
    res.status(200).json({ status: "Received" });

    // 2. Tiếp nhận Payload dữ liệu từ Webhook AppSheet gửi sang
    // ID: Mã bản ghi bài làm
    // BookingInfo: Dữ liệu từ cột [Thông tin booking] của bảng cha
    // StudentAnswer: Nội dung Booking Request từ cột [Câu trả lời_user] của bảng con
    const { ID, BookingInfo, StudentAnswer } = req.body;

    console.log(`\n=== TIẾN TRÌNH PHÁT HÀNH BOOKING NOTE ĐỘNG - ID: ${ID} ===`);

    // 3. KÍCH HOẠT TIẾN TRÌNH CHẠY NGẦM BẤT ĐỒNG BỘ (ASYNC WORKER)
    processDynamicBooking(ID, BookingInfo, StudentAnswer);
});

async function processDynamicBooking(id, bookingInfo, studentAnswer) {
    try {
        // Tự động tính toán Ngày Hệ Thống làm gốc tọa độ thời gian (Anchor Date)
        const today = new Date();
        const formattedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

        // PROMPT ĐƯỢC THIẾT KẾ ĐỂ AI ĐÓNG VAI HÃNG TÀU PHÁT HÀNH CHỨNG TỪ THEO YÊU CẦU CỦA USER
        const prompt = `
You are the automated Booking Desk System of a global Container Shipping Line. Your only job is to process the [STUDENT BOOKING REQUEST], calculate freight rates based on the [PRICING MATRIX], and output the official Booking Confirmation.

CRITICAL LOGIC RULES:
1. LANGUAGE ENFORCEMENT:
   - Scan [STUDENT BOOKING REQUEST] for ANY Vietnamese words or accents (e.g., "tôi", "muốn", "ngày", "cảng", "vui lòng", "cont", etc.).
   - If ANY Vietnamese text is found, instantly set "is_vietnamese" to true.

2. AS-IS PROCESSING (NO VALIDATION AGAINST RIGHT/WRONG ANSWERS):
   - If "is_vietnamese" is false, DO NOT check if the student chose the correct port or container size. Accept whatever they wrote and generate the Booking Note based exactly on their input.
   - Extract the Port of Loading (POL), Port of Discharge (POD), Container Type, and requested ETD directly from the student's text.

3. DYNAMIC FREIGHT RATE CALCULATION:
   - Read the [PRICING MATRIX] to find the base rate for the requested destination region and container size.
   - Compare the student's requested ETD with the [CURRENT DATE REFERENCE] to apply time-based surcharges (+10% or -10%) exactly as instructed in the pricing matrix.
   - Calculate the final total amount and include it inside the generated Booking Confirmation.

4. DEADLINES CALCULATION:
   - Empty Pick-up Date = ETD minus 5 days.
   - SI Cut-off = ETD minus 3 days at 10:00 AM.
   - VGM Cut-off = ETD minus 2 days at 14:00 PM.
   - CY Cut-off / Closing Time = ETD minus 1 day at 17:00 PM.

[PRICING MATRIX (Thông tin booking)]:
${bookingInfo}

[CURRENT DATE REFERENCE]: ${formattedDate}

[STUDENT BOOKING REQUEST (Câu trả lời_user)]:
${studentAnswer || ""}

---
YOU MUST RESPOND ONLY WITH A RAW JSON OBJECT. DO NOT WRAP IN MARKDOWN CODE BLOCKS (\`\`\`json).
The final booking_note text document MUST BE 100% IN PROFESSIONAL ENGLISH with maritime jargon.

Required JSON Schema:
{
  "is_vietnamese": true/false,
  "booking_note": "The full 100% English Booking Confirmation layout text showing the extracted POL, POD, Container Type, Calculated Deadlines, and the final calculated Freight Rate. Leave as empty string '' if is_vietnamese is true."
}
`;

        const model = genAI.getGenerativeModel({ 
            model: MODEL_NAME,
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
        });

        const result = await model.generateContent(prompt);
        const aiResult = JSON.parse(result.response.text());

        let finalBookingNote = "";
        let finalStateManagement = "";

        // THIẾT LẬP LUỒNG ĐIỀU HƯỚNG DỮ LIỆU CHUẨN XÁC THEO YÊU CẦU MỚI
        if (aiResult.is_vietnamese === true) {
            console.log(`[Language Error] ID: ${id} - Học viên viết bằng Tiếng Việt.`);
            finalBookingNote = ""; // Ô AI_tạo lập xóa trống hoàn toàn để không cho làm tiếp
            finalStateManagement = "Yêu cầu viết lại (Sai ngôn ngữ)"; // Cảnh báo duy nhất tại cột này
        } else {
            console.log(`[Success] ID: ${id} - Booking Tiếng Anh hợp lệ. Đang phát hành chứng từ dựa trên request...`);
            finalBookingNote = aiResult.booking_note; // Đổ bản thảo Booking Note tiếng Anh vào ô AI_tạo lập
            finalStateManagement = ""; // Xóa thông báo lỗi cũ nếu có ở ô State Management_booking
        }

        // Đồng bộ dữ liệu về AppSheet Database thông qua Rest API
        await updateAppSheetDatabase(id, finalBookingNote, finalStateManagement);

    } catch (error) {
        console.error(`!!! Thất bại hệ thống tại bản ghi ID ${id}:`, error.message);
    }
}

async function updateAppSheetDatabase(id, bookingNote, stateStatus) {
    const tableName = encodeURIComponent("thực hành_user_module"); 
    const url = `https://api.appsheet.com/api/v2/apps/${process.env.APPSHEET_APP_ID}/tables/${tableName}/Action`;

    const body = {
        "Action": "Edit",
        "Properties": { "Locale": "vi-VN", "Timezone": "SE Asia Standard Time" },
        "Rows": [{ 
            "ID": id, 
            "AI_tạo lập": bookingNote,                         // Cột AI_tạo lập
            "State Management_booking": stateStatus             // Cột State Management_booking
        }]
    };

    try {
        await axios.post(url, body, {
            headers: { 'ApplicationAccessKey': process.env.APPSHEET_ACCESS_KEY, 'Content-Type': 'application/json' }
        });
        console.log(`[Sync Success] Đã cập nhật thành công dữ liệu cho dòng ID: ${id}`);
    } catch (err) {
        console.error("!!! Lỗi kết nối đường truyền API AppSheet:", err.message);
    }
}

app.use((req, res) => { res.status(404).send("Endpoint không hợp lệ."); });
app.listen(PORT, () => { console.log(`🚀 Hãng tàu AI (Carrier Engine) phục vụ chặng 1 đã hoạt động tại Port: ${PORT}`); });
