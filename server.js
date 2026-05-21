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
    // BƯỚC 1: Phản hồi lập tức HTTP 200 OK giải phóng hàng đợi UI cho AppSheet
    res.status(200).json({ status: "Received" });

    // BƯỚC 2: Tiếp nhận Payload từ Webhook AppSheet
    const { ID, BookingInfo, StudentAnswer } = req.body;

    console.log(`\n=== [CHẶNG 1] KHỞI CHẠY CỖ MÁY CẤP BOOKING NOTE ĐỘNG 2026 - ID: ${ID} ===`);

    // BƯỚC 3: KÍCH HOẠT WORKER CHẠY NGẦM BẤT ĐỒNG BỘ
    processCarrierCoreWorkflow(ID, BookingInfo, StudentAnswer);
});

async function processCarrierCoreWorkflow(id, bookingInfo, studentAnswer) {
    try {
        // Tự động neo ngày hệ thống theo thời gian thực (Anchor Date)
        const today = new Date();
        const formattedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

        // PROMPT SIÊU LẬP TRÌNH: Ép AI xử lý toán học và lọc 4 tầng điều kiện nghiêm ngặt
        const prompt = `
You are the automated Carrier Booking Desk Desk of a global Container Shipping Line. Your role is to critically audit the [STUDENT BOOKING REQUEST] against the rules in [PRICING & OPERATIONAL MATRIX], perform dynamic calculations, and output a structured JSON response.

CRITICAL COMPLIANCE AUDIT FLOW:

1. LANGUAGE FILTER (Layer 1):
   - Check if [STUDENT BOOKING REQUEST] contains ANY Vietnamese words or marks (e.g., "tôi muốn", "cảng", "ngày", "vui lòng", "cont", etc.).
   - If ANY Vietnamese text is detected, instantly set "is_vietnamese" to true.

2. PORT OF LOADING AUDIT (Layer 2):
   - Extract the Port of Loading (POL). The allowed ports are ONLY "Cat Lai" (or Ho Chi Minh/Cat Lai) and "Hai Phong".
   - If the student requests ANY other port as POL (e.g., Da Nang, Qui Nhon, Vung Tau), instantly set "is_invalid_port" to true.

3. EQUIPMENT TYPE AUDIT (Layer 3):
   - Extract the Container Type. Only Dry Containers ("DC", "GP", "HC") are supported.
   - If the student requests Reefer (RF), Open Top (OT), Flat Rack (FR), or any special equipment, instantly set "is_invalid_equipment" to true.

4. FREE TIME POLICY AUDIT (Layer 4):
   - If the student explicitly inputs or demands "Request Extended Free Time" inside their text, instantly set "is_invalid_freetime_request" to true.

5. AS-IS LOGISTIC PROCESSING:
   - If "is_vietnamese", "is_invalid_port", "is_invalid_equipment", and "is_invalid_freetime_request" are all FALSE, accept whatever destination port (POD) and dates the student requested without judging right/wrong answers. 
   - Default Bill Type: If the student does not specify the Bill type, default to "Original Bill" and set Telex release fee to 0 USD.

6. TIME & DEADLINE COMPUTATION (Section 8 rules):
   - Compute deadlines strictly backward from the student's requested ETD:
     * Empty Pick-up Date = ETD minus 5 days (Format: DD/MM/YYYY)
     * SI & VGM Cut-off Time = ETD minus 3 days at 11:30 AM (Format: DD/MM/YYYY)
     * CY Cut-off / Closing Time = ETD minus 2 days at 17:00 PM (Format: DD/MM/YYYY)
     * Estimated Time of Arrival (ETA) = ETD plus 14 days (Format: DD/MM/YYYY)

7. DYNAMIC TARIFF CALCULATIONS:
   - Calculate Ocean Freight (O/F) using Base rates, Equipment modifier (40FT = 150%), and Time-based seasonal behavior logic (+10% or -10%) relative to the [SYSTEM CURRENT DATE REFERENCE].
   - Add all mandatory Section 5 Local Charges. If Europe, add ENS and EU ETS. If America, add AMS. If Japan, add AFR. If China, add CCAM.

[PRICING & OPERATIONAL MATRIX (Thông tin booking)]:
${bookingInfo}

[SYSTEM CURRENT DATE REFERENCE]: ${formattedDate}

[STUDENT BOOKING REQUEST (Câu trả lời_user)]:
${studentAnswer || ""}

---
YOU MUST RESPOND ONLY WITH A RAW JSON OBJECT. DO NOT WRAP IN MARKDOWN CODE BLOCKS.
The document text inside "booking_note" MUST BE 100% IN PROFESSIONAL ENGLISH.

Required JSON Schema:
{
  "is_vietnamese": true/false,
  "is_invalid_port": true/false,
  "is_invalid_equipment": true/false,
  "is_invalid_freetime_request": true/false,
  "rejection_reason": "Specific English message explaining the exact error clause if rejected",
  "booking_note": "The complete shipping layout confirmation document string text, or empty string '' if any of the audit fields are true."
}
`;

        // Gọi cấu hình Gemini Engine với độ sáng tạo thấp (temperature: 0.1) để tính tiền cơ học chính xác
        const model = genAI.getGenerativeModel({ 
            model: MODEL_NAME,
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
        });

        const result = await model.generateContent(prompt);
        const aiResult = JSON.parse(result.response.text());

        let targetBookingNote = "";
        let targetStateManagement = "";

        // CỖ MÁY ĐIỀU HƯỚNG DỮ LIỆU ĐỘNG VÀO ĐÚNG CỘT DATABASE THEO LOGIC MỚI VÀ MA TRẬN MỚI
        if (aiResult.is_vietnamese === true) {
            targetBookingNote = ""; 
            targetStateManagement = "Yêu cầu viết lại (Sai ngôn ngữ)";
        } 
        else if (aiResult.is_invalid_port === true) {
            targetBookingNote = ""; 
            targetStateManagement = "No space available for this routing. Please verify your port of loading and select another port.";
        } 
        else if (aiResult.is_invalid_equipment === true) {
            targetBookingNote = "";
            targetStateManagement = "Rejected: Pricing for Reefer/Special Equipment not supported in this matrix. Please select Dry Containers only.";
        }
        else if (aiResult.is_invalid_freetime_request === true) {
            targetBookingNote = "";
            targetStateManagement = "Rejected: Carrier standard free time policy applies. Extended free time requests are not permitted.";
        }
        else {
            targetBookingNote = aiResult.booking_note;
            targetStateManagement = ""; // Clear sạch lỗi cũ khi học viên đã sửa đổi đúng phom
        }

        // Thực thi cuộc gọi REST API đồng bộ kết quả về AppSheet Database
        await updateAppSheetDatabase(id, targetBookingNote, targetStateManagement);

    } catch (error) {
        console.error(`!!! Lỗi xử lý chặng 1 tại bản ghi ID ${id}:`, error.message);
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
            "AI_tạo lập": bookingNote, 
            "State Management_booking": stateStatus
        }]
    };

    try {
        await axios.post(url, body, {
            headers: { 'ApplicationAccessKey': process.env.APPSHEET_ACCESS_KEY, 'Content-Type': 'application/json' }
        });
        console.log(`[Database Update Success] Đã đồng bộ dòng dữ liệu ID: ${id}`);
    } catch (err) {
        console.error("!!! Thất bại khi gọi REST API AppSheet Database:", err.message);
    }
}

app.listen(PORT, () => { console.log(`🚀 [Hãng Tàu AI - Chặng 1] Vận hành ma trận 2026 đã mở tại Port: ${PORT}`); });
