import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

export const DailyReport: React.FC = () => {
    const { projectId, reportId } = useParams<{ projectId: string, reportId: string }>();
    const navigate = useNavigate();
    const isNew = reportId === 'new';

    const [formData, setFormData] = useState({
        date: new Date().toISOString().split('T')[0],
        weather: '',
        workers: '',
        workDescription: '',
        materials: ''
    });

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        console.log('Submitting report', formData);
        // Mock success
        navigate(`/projects/${projectId}`);
    };

    return (
        <div className="p-4 max-w-2xl mx-auto">
            <h1 className="text-2xl font-bold mb-6">
                {isNew ? 'Create Daily Report' : `Edit Report ${reportId}`}
            </h1>
            
            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                    <label className="block text-sm font-medium mb-1">Date</label>
                    <input 
                        type="date" 
                        name="date" 
                        value={formData.date} 
                        onChange={handleChange}
                        className="w-full border p-2 rounded"
                        required 
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium mb-1">Weather Conditions</label>
                    <input 
                        type="text" 
                        name="weather" 
                        value={formData.weather} 
                        onChange={handleChange}
                        className="w-full border p-2 rounded"
                        placeholder="e.g. Sunny, 22°C"
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium mb-1">Workers on Site</label>
                    <textarea 
                        name="workers" 
                        value={formData.workers} 
                        onChange={handleChange}
                        className="w-full border p-2 rounded"
                        rows={3}
                        placeholder="List workers and their roles..."
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium mb-1">Work Description</label>
                    <textarea 
                        name="workDescription" 
                        value={formData.workDescription} 
                        onChange={handleChange}
                        className="w-full border p-2 rounded"
                        rows={5}
                        placeholder="Describe the work done today..."
                        required
                    />
                </div>
                <div>
                    <label className="block text-sm font-medium mb-1">Materials Used</label>
                    <textarea 
                        name="materials" 
                        value={formData.materials} 
                        onChange={handleChange}
                        className="w-full border p-2 rounded"
                        rows={3}
                        placeholder="List materials used or delivered..."
                    />
                </div>
                
                <div className="flex justify-end space-x-2 pt-4">
                    <button 
                        type="button" 
                        onClick={() => navigate(-1)}
                        className="px-4 py-2 border rounded hover:bg-gray-100"
                    >
                        Cancel
                    </button>
                    <button 
                        type="submit" 
                        className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                    >
                        Save Report
                    </button>
                </div>
            </form>
        </div>
    );
};
